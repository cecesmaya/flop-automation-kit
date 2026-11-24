/**
 * Environment-based configuration.
 *
 * All endpoints are configurable so the same code can move from the
 * FLOP devnet (verified 2026-11-24) to the real testnet when it opens.
 * No default below points at any unofficial or third-party service.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { ConfigError } from './errors.js';

dotenv.config();

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const raw = env(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`Environment variable ${name} must be a non-negative integer, got: ${raw}`);
  }
  return value;
}

function envUrl(name, fallback) {
  const value = env(name, fallback);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('must use http(s)');
    }
    return value.replace(/\/$/, '');
  } catch (err) {
    throw new ConfigError(`Environment variable ${name} is not a valid URL: ${value} (${err.message})`);
  }
}

const keystoreDir = path.resolve(env('FLOP_KEYSTORE_DIR', './keystore'));
const dataDir = path.resolve(env('FLOP_DATA_DIR', './data'));

export const config = {
  // --- official FLOP surfaces (devnet-verified 2026-11-24) ---
  faucetUrl: envUrl('FLOP_FAUCET_URL', 'https://faucet.flop.network'),
  rpcUrl: envUrl('FLOP_RPC_URL', 'https://rpc.devnet.flop.network'),
  gatewayUrl: envUrl('FLOP_GATEWAY_URL', 'https://api.flop.network'),
  faucetClient: env('FLOP_FAUCET_CLIENT', 'flop-llms-txt'),

  // --- chain identity (devnet; update when the testnet chain is published) ---
  chainSs58: envInt('FLOP_CHAIN_SS58', 42),
  chainGenesis: env(
    'FLOP_CHAIN_GENESIS',
    '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631',
  ),
  chainDecimals: envInt('FLOP_CHAIN_DECIMALS', 18),
  chainSymbol: env('FLOP_CHAIN_SYMBOL', 'FLOP'),

  // --- local storage ---
  keystoreDir,
  dataDir,
  gatewayKeyFile: path.resolve(env('FLOP_GATEWAY_KEY_FILE', path.join(keystoreDir, 'gateway.key'))),
  trackerDbFile: path.resolve(env('FLOP_TRACKER_DB', path.join(dataDir, 'activity.db'))),

  // --- HTTP behaviour ---
  httpTimeoutMs: envInt('FLOP_HTTP_TIMEOUT_MS', 30000),
  inferenceTimeoutMs: envInt('FLOP_INFERENCE_TIMEOUT_MS', 300000),
  maxRetries: envInt('FLOP_MAX_RETRIES', 4),
  retryBaseMs: envInt('FLOP_RETRY_BASE_MS', 1000),
  minRequestIntervalMs: envInt('FLOP_MIN_REQUEST_INTERVAL_MS', 500),
  maxRetryAfterMs: envInt('FLOP_MAX_RETRY_AFTER_MS', 120000),

  // --- Hermes provider (optional; empty = not configured) ---
  hermesEndpoint: env('FLOP_HERMES_ENDPOINT', ''),
  hermesBinary: env('FLOP_HERMES_BINARY', ''),
  hermesConfigFile: path.resolve(env('FLOP_HERMES_CONFIG', './hermes.config.json')),

  logLevel: env('FLOP_LOG_LEVEL', 'info'),
};

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}
