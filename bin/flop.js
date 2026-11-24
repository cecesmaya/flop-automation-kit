#!/usr/bin/env node
/**
 * flop — CLI for flop-automation-kit.
 *
 * Usage:
 *   flop identity generate [--name <name>] [--dir <dir>]
 *   flop identity status [--keystore <file>]
 *   flop faucet limits | chain | health
 *   flop faucet claim [--address <ss58> | --keystore <file>]
 *   flop gateway enroll [--keystore <file>]
 *   flop gateway models
 *   flop inference run --model <model> --prompt <text> [--max-tokens <n>] [--stream]
 *   flop hermes setup
 *   flop hermes check
 *   flop tracker export [--format json|csv] [--table <table>] [--out <file>]
 *   flop dashboard [--out <file>] [--serve] [--port <n>]
 *
 * Passwords come from FLOP_KEYSTORE_PASSWORD or an interactive prompt.
 * They are never accepted as a --password flag (it would leak into history).
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { config, requireEnv } from '../src/config.js';
import { logger } from '../src/logger.js';
import { FlopError, ConfigError } from '../src/errors.js';
import { generateIdentity, identityStatus, identityFile, unlockIdentity } from '../src/identity.js';
import { Faucet } from '../src/faucet.js';
import { Gateway, saveGatewayKey, loadGatewayKey } from '../src/gateway.js';
import { InferenceRunner } from '../src/inference.js';
import { hermesSetup, checkEndpoint } from '../src/hermes.js';
import { Tracker, writeExport } from '../src/tracker.js';
import { generateDashboard } from '../src/dashboard.js';

const VERSION = '0.1.0';

const HELP = `flop ${VERSION} — automation toolkit for FLOP Network testnet activities
(devnet-verified only; the real testnet has not opened yet — Draft, Q4 2026)

Commands:
  identity generate [--name <name>] [--dir <dir>]   Generate a new agent identity (encrypted keystore)
  identity status [--keystore <file>]               Show public status of an identity
  faucet limits | chain | health                    Query the official faucet
  faucet claim [--address <ss58> | --keystore <file>]
                                                    Claim a faucet grant (24h cooldown per address)
  gateway enroll [--keystore <file>]                Enroll an identity, get a gateway API key
  gateway models                                    List available models (no auth)
  inference run --model <m> --prompt <text> [--max-tokens <n>] [--stream]
                                                    Run one inference request, record the outcome
  hermes setup                                      Validate Hermes provider setup (never invents a binary URL)
  hermes check                                      Health-check a configured provider endpoint
  tracker export [--format json|csv] [--table <table>] [--out <file>]
                                                    Export activity records
  dashboard [--out <file>] [--serve] [--port <n>]  Generate (and optionally serve) the HTML dashboard

Options:
  --help, -h        Show this help
  --version         Show version
  --env <file>      Load environment from a different .env file

Environment (see .env.example):
  FLOP_KEYSTORE_PASSWORD   Keystore password (or enter it interactively)
  FLOP_FAUCET_URL, FLOP_GATEWAY_URL, FLOP_RPC_URL   Official endpoints (devnet defaults)
  FLOP_KEYSTORE_DIR, FLOP_DATA_DIR, FLOP_GATEWAY_KEY_FILE
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

async function promptHidden(query) {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(query, resolve));
    rl.close();
    return answer;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    let input = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      if (s === '\n' || s === '\r' || s === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (s === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (s === '\u007f' || s === '\b') {
        input = input.slice(0, -1);
        process.stdout.write('\b \b');
      } else {
        input += s;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassword(confirm = false) {
  const envPassword = process.env.FLOP_KEYSTORE_PASSWORD;
  if (envPassword) return envPassword;
  const password = await promptHidden('Keystore password: ');
  if (confirm) {
    const again = await promptHidden('Confirm keystore password: ');
    if (password !== again) throw new ConfigError('Passwords do not match');
  }
  return password;
}

function resolveKeystoreFile(flags) {
  return flags.keystore ? path.resolve(flags.keystore) : identityFile(config.keystoreDir, flags.name ?? 'agent');
}

function openTracker() {
  return new Tracker(config.trackerDbFile);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function cmdIdentityGenerate(flags) {
  const password = await getPassword(true);
  const name = flags.name ?? 'agent';
  const dir = flags.dir ? path.resolve(flags.dir) : config.keystoreDir;
  const result = await generateIdentity({ password, name, dir, ss58Format: config.chainSs58 });
  console.log(`Identity created: ${result.name}`);
  console.log(`  address:  ${result.address}`);
  console.log(`  keystore: ${result.file} (0600)`);
  console.log('  Keep the password safe — it cannot be recovered.');
  return result;
}

async function cmdIdentityStatus(flags) {
  const file = resolveKeystoreFile(flags);
  const status = await identityStatus(file);
  if (!status) {
    console.log(`No keystore found at ${file}. Run: flop identity generate`);
    return null;
  }
  printJson(status);
  return status;
}

async function cmdFaucet(flags, sub) {
  const faucet = new Faucet({
    baseURL: config.faucetUrl,
    client: config.faucetClient,
    ss58Format: config.chainSs58,
    httpOptions: {
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.maxRetries,
      retryBaseMs: config.retryBaseMs,
      maxRetryAfterMs: config.maxRetryAfterMs,
      minRequestIntervalMs: config.minRequestIntervalMs,
    },
  });
  if (sub === 'limits' || sub === 'chain' || sub === 'health') {
    printJson(await faucet[sub]());
    return;
  }
  if (sub !== 'claim') throw new ConfigError(`Unknown faucet subcommand: ${sub}`);
  let address = flags.address;
  if (!address && flags.keystore) {
    const status = await identityStatus(resolveKeystoreFile(flags));
    if (!status) throw new ConfigError(`No keystore found at ${resolveKeystoreFile(flags)}`);
    address = status.address;
  }
  if (!address) throw new ConfigError('faucet claim needs --address <ss58> or --keystore <file>');
  const tracker = openTracker();
  try {
    const result = await faucet.claim(address);
    tracker.recordFaucetClaim({
      id: randomUUID(), createdAt: new Date().toISOString(), address: result.address,
      status: 'completed', amount: result.amount, txHash: result.txHash, tier: result.tier,
    });
    console.log(`Faucet grant claimed for ${result.address}`);
    if (result.amount) console.log(`  amount: ${result.amount}`);
    if (result.txHash) console.log(`  tx: ${result.txHash}`);
    if (result.tier) console.log(`  tier: ${result.tier}`);
    return result;
  } catch (err) {
    tracker.recordFaucetClaim({
      id: randomUUID(), createdAt: new Date().toISOString(), address,
      status: 'failed', errorCode: err.code ?? 'UNKNOWN', errorMessage: err.message,
    });
    throw err;
  } finally {
    tracker.close();
  }
}

async function cmdGateway(flags, sub) {
  const gateway = new Gateway({
    baseURL: `${config.gatewayUrl}/v1`,
    httpOptions: {
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.maxRetries,
      retryBaseMs: config.retryBaseMs,
      maxRetryAfterMs: config.maxRetryAfterMs,
      minRequestIntervalMs: config.minRequestIntervalMs,
    },
  });
  if (sub === 'models') {
    const models = await gateway.listModels();
    printJson(models);
    return models;
  }
  if (sub !== 'enroll') throw new ConfigError(`Unknown gateway subcommand: ${sub}`);
  const file = resolveKeystoreFile(flags);
  const password = await getPassword();
  const { pair, address } = await unlockIdentity(file, password, config.chainSs58);
  const record = await gateway.enrollPair(pair, address);
  const keyFile = await saveGatewayKey(config.gatewayKeyFile, record.apiKey);
  const tracker = openTracker();
  try {
    tracker.recordEnrollment({
      id: randomUUID(), createdAt: new Date().toISOString(), address,
      model: record.model, remainingQuota: record.remainingQuota,
      expiresAt: record.expiresAt, status: 'completed',
    });
  } finally {
    tracker.close();
  }
  console.log(`Gateway enrollment completed for ${address}`);
  console.log(`  model: ${record.model ?? 'unknown'}`);
  console.log(`  remaining quota: ${record.remainingQuota ?? 'unknown'} FLOP`);
  console.log(`  key expires: ${record.expiresAt ?? 'unknown'}`);
  console.log(`  API key saved to ${keyFile} (0600) — it is never printed.`);
  return record;
}

async function cmdInferenceRun(flags) {
  const model = flags.model;
  const prompt = flags.prompt;
  if (!model) throw new ConfigError('inference run needs --model <model>');
  if (!prompt) throw new ConfigError('inference run needs --prompt <text>');
  const maxTokens = flags['max-tokens'] ? Number(flags['max-tokens']) : undefined;
  const apiKey = process.env.FLOP_GATEWAY_KEY ?? (await loadGatewayKey(config.gatewayKeyFile));
  const runner = new InferenceRunner({
    baseURL: `${config.gatewayUrl}/v1`,
    timeoutMs: config.inferenceTimeoutMs,
    httpOptions: {
      timeoutMs: config.inferenceTimeoutMs,
      maxRetries: 0, // inference retries would double-spend quota; never retry a run
      minRequestIntervalMs: config.minRequestIntervalMs,
    },
  });
  const record = await runner.run({
    apiKey,
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    stream: Boolean(flags.stream),
    onChunk: flags.stream ? (text) => process.stdout.write(text) : null,
  });
  if (flags.stream) process.stdout.write('\n');
  const tracker = openTracker();
  try {
    tracker.recordInferenceRun(record);
  } finally {
    tracker.close();
  }
  console.log(`Inference ${record.status} (${record.durationMs}ms)`);
  console.log(`  request id: ${record.requestId}`);
  if (record.promptTokens !== null) console.log(`  tokens: prompt ${record.promptTokens}, completion ${record.completionTokens}, total ${record.totalTokens} (${record.usageSource})`);
  console.log(`  settled (verified): ${record.settled ? 'yes' : 'no'} — ${record.settlementReason}`);
  if (record.errorMessage) console.log(`  error: ${record.errorCode}: ${record.errorMessage}`);
  if (record.status === 'completed' && record.text) console.log(`\n${record.text}`);
  return record;
}

async function cmdHermes(flags, sub) {
  if (sub === 'check') {
    const result = await checkEndpoint(config.hermesEndpoint || null, {});
    printJson(result);
    return result;
  }
  if (sub !== 'setup') throw new ConfigError(`Unknown hermes subcommand: ${sub}`);
  const report = await hermesSetup({
    endpoint: config.hermesEndpoint || null,
    binary: config.hermesBinary || null,
    configFile: config.hermesConfigFile,
  });
  printJson(report);
  if (!report.configured) {
    console.log('\nHermes provider is NOT configured. No official provider binary URL is published/verified;');
    console.log('set FLOP_HERMES_ENDPOINT or FLOP_HERMES_BINARY after verifying the source yourself.');
  }
  return report;
}

async function cmdTrackerExport(flags) {
  const format = flags.format ?? 'json';
  const table = flags.table ?? 'inference_runs';
  const out = flags.out ? path.resolve(flags.out) : path.resolve(config.dataDir, format === 'csv' ? `export-${table}.csv` : 'export.json');
  const tracker = openTracker();
  try {
    let content;
    if (format === 'json') {
      content = `${JSON.stringify(tracker.exportJson(), null, 2)}\n`;
    } else if (format === 'csv') {
      content = tracker.exportCsv(table);
    } else {
      throw new ConfigError(`Unknown export format: ${format} (use json or csv)`);
    }
    await writeExport(out, content);
    console.log(`Exported ${format} to ${out}`);
    return out;
  } finally {
    tracker.close();
  }
}

async function cmdDashboard(flags) {
  const out = flags.out ? path.resolve(flags.out) : path.resolve(config.dataDir, 'dashboard.html');
  const { summary } = await generateDashboard({
    dbFile: config.trackerDbFile,
    keystoreFile: resolveKeystoreFile(flags),
    outFile: out,
  });
  console.log(`Dashboard written to ${out}`);
  console.log(`  runs: ${summary.runs}, estimated tokens: ${summary.estimatedTokens}, verified tokens: ${summary.verifiedTokens}, settled runs: ${summary.settledRuns}`);
  if (flags.serve) {
    const port = Number(flags.port ?? 8787);
    const server = http.createServer(async (req, res) => {
      try {
        const html = await fs.readFile(out, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('Dashboard not available');
      }
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`Serving dashboard at http://127.0.0.1:${port} (Ctrl+C to stop)`);
    await new Promise(() => {}); // run until interrupted
  }
  return out;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.env) {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: path.resolve(flags.env), override: true });
  }
  if (flags.help || flags.h || positionals.length === 0) {
    console.log(HELP);
    return;
  }
  if (flags.version) {
    console.log(`flop ${VERSION}`);
    return;
  }
  const [cmd, sub] = positionals;
  try {
    switch (cmd) {
      case 'identity':
        if (sub === 'generate') await cmdIdentityGenerate(flags);
        else if (sub === 'status') await cmdIdentityStatus(flags);
        else throw new ConfigError(`Unknown identity subcommand: ${sub ?? '(none)'} (use generate|status)`);
        break;
      case 'faucet':
        await cmdFaucet(flags, sub);
        break;
      case 'gateway':
        await cmdGateway(flags, sub);
        break;
      case 'inference':
        if (sub === 'run') await cmdInferenceRun(flags);
        else throw new ConfigError(`Unknown inference subcommand: ${sub ?? '(none)'} (use run)`);
        break;
      case 'hermes':
        await cmdHermes(flags, sub);
        break;
      case 'tracker':
        if (sub === 'export') await cmdTrackerExport(flags);
        else throw new ConfigError(`Unknown tracker subcommand: ${sub ?? '(none)'} (use export)`);
        break;
      case 'dashboard':
        await cmdDashboard(flags);
        break;
      default:
        throw new ConfigError(`Unknown command: ${cmd}\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof FlopError) {
      logger.error(`Command failed [${err.code}]`, { message: err.message });
      console.error(`Error [${err.code}]: ${err.message}`);
    } else {
      logger.error('Command failed', { message: String(err?.message ?? err) });
      console.error(`Error: ${err?.message ?? err}`);
    }
    process.exitCode = 1;
  }
}

main();
