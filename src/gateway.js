/**
 * Gateway module — FLOP API enrollment + model listing.
 *
 * Verified flow (devnet, 2026-11-24):
 *   GET  /v1/enroll/wallet/challenge?address=<ss58>  -> { message, nonce, expires_at }
 *   POST /v1/enroll/wallet { address, message, signature }  -> API key + quota
 *   GET  /v1/models  -> model list (no auth)
 *
 * The signature is sr25519 over the EXACT challenge message bytes. The API
 * key returned by enroll is written to a 0600 file and never logged.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpClient } from './http.js';
import { FlopError } from './errors.js';
import { validateSs58Address } from './validate.js';
import { logger } from './logger.js';

export class Gateway {
  /**
   * @param {object} opts
   * @param {HttpClient} [opts.http]
   * @param {string} [opts.baseURL]
   * @param {object} [opts.httpOptions]
   */
  constructor(opts) {
    this.http = opts.http ?? new HttpClient({ baseURL: opts.baseURL, ...(opts.httpOptions ?? {}) });
  }

  /** Fetch a fresh enrollment challenge for an address. */
  async getChallenge(address) {
    const { address: normalized } = await validateSs58Address(address);
    const res = await this.http.request({
      method: 'GET',
      path: '/enroll/wallet/challenge',
      params: { address: normalized },
    });
    const data = res.data ?? {};
    if (!data.message || typeof data.message !== 'string') {
      throw new FlopError('GATEWAY_ERROR', 'Challenge response did not contain a message to sign', { retryable: false });
    }
    if (data.expires_at) {
      const expiresMs = Date.parse(data.expires_at);
      if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
        throw new FlopError('GATEWAY_ERROR', 'Challenge already expired; request a fresh one', { retryable: true });
      }
    }
    return { address: normalized, message: data.message, nonce: data.nonce ?? null, expiresAt: data.expires_at ?? null };
  }

  /** Submit a signed challenge. Returns the enrollment record (key kept out of logs). */
  async submitEnrollment({ address, message, signature }) {
    const res = await this.http.request({
      method: 'POST',
      path: '/enroll/wallet',
      data: { address, message, signature },
    });
    const data = res.data ?? {};
    const apiKey = data.apiKey ?? data.key ?? data.api_key ?? data.token ?? null;
    if (!apiKey || typeof apiKey !== 'string') {
      throw new FlopError('GATEWAY_ERROR', 'Enrollment response did not contain an API key', { retryable: false });
    }
    return {
      apiKey,
      model: data.model ?? data.models?.[0] ?? null,
      remainingQuota: data.remaining_quota ?? data.remainingQuota ?? null,
      expiresAt: data.expires_at ?? data.expiresAt ?? null,
      address,
    };
  }

  /**
   * Full enrollment for an unlocked keypair: challenge -> sign -> submit.
   * @param {object} pair @polkadot sr25519 keypair (from unlockIdentity)
   * @param {string} address SS58 address of the pair
   */
  async enrollPair(pair, address) {
    const challenge = await this.getChallenge(address);
    const messageBytes = new TextEncoder().encode(challenge.message);
    const signature = pair.sign(messageBytes);
    const signatureHex = `0x${Buffer.from(signature).toString('hex')}`;
    const record = await this.submitEnrollment({ address, message: challenge.message, signature: signatureHex });
    logger.info('Gateway enrollment completed', {
      address, model: record.model, remainingQuota: record.remainingQuota, expiresAt: record.expiresAt,
    });
    return record;
  }

  /** List available models (no auth required). */
  async listModels() {
    const res = await this.http.request({ method: 'GET', path: '/models' });
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.models)) return data.models;
    return [];
  }
}

/** Persist a gateway API key to a 0600 file. The key is never returned to logs. */
export async function saveGatewayKey(file, apiKey) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${apiKey.trim()}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
  return file;
}

/** Read a gateway API key from its 0600 file. */
export async function loadGatewayKey(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const key = raw.trim();
    if (!key) throw new Error('empty key file');
    return key;
  } catch (err) {
    throw new FlopError('GATEWAY_KEY_MISSING', `Cannot read gateway key file: ${file} (enroll first)`, { cause: err, retryable: false });
  }
}
