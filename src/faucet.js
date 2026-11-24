/**
 * Faucet module — official FLOP faucet API only.
 *
 * Verified against the devnet faucet 2026-11-24:
 *   GET  /limits  -> grant size, cooldown, daily cap
 *   GET  /chain   -> chain identity (name, genesis, ss58Format, decimals)
 *   GET  /health  -> service status
 *   POST /fund    -> { address, client } grants test FLOP, returns a tx hash
 *
 * The module never bypasses CAPTCHA, anti-bot checks, or access controls:
 * if the faucet answers with a challenge (e.g. a captcha/verification step),
 * claim() surfaces a MANUAL_ACTION_REQUIRED error and stops. There is no
 * code path that attempts to solve, skip, or work around such a challenge.
 */
import { HttpClient } from './http.js';
import { FlopError, ValidationError } from './errors.js';
import { validateSs58Address } from './validate.js';
import { logger } from './logger.js';

export const FAUCET_PATHS = { limits: '/limits', chain: '/chain', health: '/health', fund: '/fund' };

export class Faucet {
  /**
   * @param {object} opts
   * @param {HttpClient} [opts.http] prebuilt client (tests inject a mock baseURL)
   * @param {string} [opts.baseURL] faucet base URL
   * @param {string} [opts.client='flop-llms-txt'] client identifier sent with /fund
   * @param {number} [opts.ss58Format=42]
   * @param {object} [opts.httpOptions] passed to HttpClient
   */
  constructor(opts) {
    this.clientName = opts.client ?? 'flop-llms-txt';
    this.ss58Format = opts.ss58Format ?? 42;
    this.http = opts.http ?? new HttpClient({ baseURL: opts.baseURL, ...(opts.httpOptions ?? {}) });
  }

  async limits() {
    const res = await this.http.request({ method: 'GET', path: FAUCET_PATHS.limits });
    return res.data;
  }

  async chain() {
    const res = await this.http.request({ method: 'GET', path: FAUCET_PATHS.chain });
    return res.data;
  }

  async health() {
    const res = await this.http.request({ method: 'GET', path: FAUCET_PATHS.health });
    return res.data;
  }

  /**
   * Claim a faucet grant for an SS58 address.
   * @returns {Promise<{address: string, amount: string|null, txHash: string|null, tier: string|null, raw: object}>}
   * @throws {FlopError} RATE_LIMITED (cooldown active), VALIDATION_ERROR (bad address),
   *   MANUAL_ACTION_REQUIRED (challenge/captcha presented), HTTP_ERROR/SERVER_ERROR
   */
  async claim(address) {
    const { address: normalized } = await validateSs58Address(address, this.ss58Format);
    let res;
    try {
      res = await this.http.request({
        method: 'POST',
        path: FAUCET_PATHS.fund,
        data: { address: normalized, client: this.clientName },
      });
    } catch (err) {
      if (err instanceof FlopError && err.code === 'RATE_LIMITED') {
        throw new FlopError(
          'FAUCET_COOLDOWN',
          `Faucet grant not available right now (rate limited${err.retryAfterMs ? `, retry after ${Math.round(err.retryAfterMs / 1000)}s` : ''}). ` +
            'The faucet enforces one grant per address per 24h; wait for the cooldown to expire.',
          { status: err.status, retryable: false, retryAfterMs: err.retryAfterMs },
        );
      }
      throw err;
    }
    const data = res.data ?? {};
    if (data && typeof data === 'object' && (data.captcha === true || data.challenge || data.verificationUrl || data.verification_url)) {
      throw new FlopError(
        'MANUAL_ACTION_REQUIRED',
        'The faucet presented a verification challenge (e.g. CAPTCHA). This toolkit never bypasses ' +
          'CAPTCHA or anti-bot checks; complete the claim manually in a browser.',
        { status: res.status, retryable: false },
      );
    }
    const amount = pickFirst(data, ['amount', 'granted', 'grant', 'value']);
    const txHash = pickFirst(data, ['txHash', 'tx_hash', 'hash', 'extrinsicHash', 'transactionHash']);
    const tier = pickFirst(data, ['tier', 'grantTier']);
    logger.info('Faucet claim completed', { address: normalized, amount: amount ?? null, tier: tier ?? null, txHash: txHash ?? null });
    return { address: normalized, amount: amount != null ? String(amount) : null, txHash: txHash ?? null, tier: tier ?? null, raw: data };
  }
}

/** Return the first defined, non-null value found under any of the given keys. */
function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

export { ValidationError };
