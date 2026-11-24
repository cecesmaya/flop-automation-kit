/**
 * Hermes provider setup / health checks.
 *
 * HONESTY RULE: there is no verified public download URL for a Hermes
 * provider binary. This module therefore NEVER invents one. It:
 *  - validates the local environment (Node version, configured paths),
 *  - checks a provider endpoint ONLY when the user configures one
 *    (FLOP_HERMES_ENDPOINT), probing its configured health path,
 *  - checks a provider binary ONLY when the user configures its path
 *    (FLOP_HERMES_BINARY),
 *  - writes an example config file with placeholders when none exists.
 * When nothing is configured it reports status 'not-configured' and says so
 * plainly. "Not configured" is a real, reportable outcome — not an error to
 * paper over with a fabricated URL.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpClient } from './http.js';
import { logger } from './logger.js';

const MIN_NODE_MAJOR = 18;

export async function checkNodeRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= MIN_NODE_MAJOR, node: process.versions.node, required: `>=${MIN_NODE_MAJOR}` };
}

/** Check whether a configured binary path exists and is executable. */
export async function checkBinary(binaryPath) {
  if (!binaryPath) return { configured: false, found: false, reason: 'No binary path configured (FLOP_HERMES_BINARY)' };
  try {
    const stat = await fs.stat(binaryPath);
    const executable = (stat.mode & 0o111) !== 0;
    return { configured: true, found: true, path: binaryPath, executable, isFile: stat.isFile() };
  } catch {
    return { configured: true, found: false, path: binaryPath, reason: 'Configured binary path does not exist' };
  }
}

/** Probe a configured provider endpoint's health path. Never guesses a URL. */
export async function checkEndpoint(endpoint, { httpOptions = {}, healthPath = '/health' } = {}) {
  if (!endpoint) return { configured: false, up: false, reason: 'No endpoint configured (FLOP_HERMES_ENDPOINT)' };
  const http = new HttpClient({ baseURL: endpoint, timeoutMs: 10000, maxRetries: 0, ...httpOptions });
  const started = Date.now();
  try {
    const res = await http.request({ method: 'GET', path: healthPath });
    return { configured: true, up: true, status: res.status, ms: Date.now() - started, data: res.data };
  } catch (err) {
    return { configured: false, up: false, status: err.status ?? null, ms: Date.now() - started, reason: err.message };
  }
}

export const HERMES_CONFIG_TEMPLATE = {
  _comment: 'Example Hermes provider configuration for flop-automation-kit. Fill in real values; never commit secrets.',
  provider: {
    endpoint: 'http://127.0.0.1:8080',
    healthPath: '/health',
    models: ['qwen/qwen2.5-0.5b-instruct'],
  },
  binary: { path: '', args: [] },
  notes: 'No official Hermes provider binary URL is published/verified as of 2026-11-24. Set FLOP_HERMES_BINARY to a locally installed binary, or FLOP_HERMES_ENDPOINT to a running provider, after verifying the source yourself.',
};

/** Write the example config file if it does not already exist. */
export async function ensureExampleConfig(file) {
  try {
    await fs.access(file);
    return { created: false, file };
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(HERMES_CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    return { created: true, file };
  }
}

/**
 * Full setup validation. Returns a report; `configured` is false when the
 * user has not pointed the kit at any real provider — that is expected until
 * an official provider distribution is published.
 */
export async function hermesSetup({ endpoint, binary, configFile, httpOptions = {} } = {}) {
  const node = await checkNodeRuntime();
  const binaryCheck = await checkBinary(binary);
  const endpointCheck = endpoint ? await checkEndpoint(endpoint, { httpOptions }) : { configured: false, up: false, reason: 'No endpoint configured (FLOP_HERMES_ENDPOINT)' };
  const config = await ensureExampleConfig(configFile);
  const configured = Boolean(endpoint || binaryCheck.found);
  const report = { node, binary: binaryCheck, endpoint: endpointCheck, exampleConfig: config, configured };
  logger.info('Hermes setup check finished', { configured, nodeOk: node.ok, binaryFound: binaryCheck.found, endpointUp: endpointCheck.up === true });
  return report;
}
