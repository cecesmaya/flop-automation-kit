/**
 * HTTP client: axios wrapped with
 *  - exponential backoff with jitter on retryable failures,
 *  - Retry-After handling (capped; a huge Retry-After becomes a terminal error),
 *  - a minimum interval between requests (client-side rate limiting),
 *  - metadata-only logging (never headers, never bodies — bodies may hold keys).
 */
import axios from 'axios';
import { FlopError } from './errors.js';
import { logger } from './logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a Retry-After value (seconds, or an HTTP date) into milliseconds. */
export function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableAxiosError(err) {
  if (err.response) return isRetryableStatus(err.response.status);
  // No response at all: network error / timeout / DNS — retryable.
  return err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
    || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || !err.code;
}

/** Retry helper with exponential backoff + jitter. Exported for unit tests. */
export async function withRetry(fn, { retries = 4, baseMs = 1000, maxRetryAfterMs = 120000, onRetry = null } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      // Duck-typed so plain errors carrying these fields behave the same as FlopError.
      const retryAfterMs = err && typeof err === 'object' && 'retryAfterMs' in err ? err.retryAfterMs : null;
      const retryable = err && typeof err === 'object' && 'retryable' in err ? err.retryable !== false : true;
      if (!retryable || attempt >= retries) throw err;
      let delay;
      if (retryAfterMs !== null && retryAfterMs !== undefined) {
        // A server-asked wait longer than the cap is not a retry — surface it.
        if (retryAfterMs > maxRetryAfterMs) {
          throw new FlopError(
            err.code ?? 'RATE_LIMITED',
            `${err.message} (server asked to wait ${Math.round(retryAfterMs / 1000)}s, over the ${Math.round(maxRetryAfterMs / 1000)}s retry cap)`,
            { status: err.status ?? null, retryable: false, retryAfterMs },
          );
        }
        delay = retryAfterMs;
      } else {
        delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
      }
      if (onRetry) onRetry({ attempt: attempt + 1, delayMs: delay, error: err });
      logger.warn(`Request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`, { code: err.code });
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** In-process rate limiter: guarantees a minimum gap between requests. */
export class RateLimiter {
  constructor(minIntervalMs = 500) {
    this.minIntervalMs = minIntervalMs;
    this.nextAt = 0;
    this.queue = Promise.resolve();
  }

  acquire() {
    const run = this.queue.then(async () => {
      const now = Date.now();
      const wait = this.nextAt - now;
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.minIntervalMs;
    });
    // Keep the chain alive even if a waiter fails.
    this.queue = run.catch(() => {});
    return run;
  }
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL
   * @param {number} [opts.timeoutMs=30000]
   * @param {number} [opts.maxRetries=4]
   * @param {number} [opts.retryBaseMs=1000]
   * @param {number} [opts.maxRetryAfterMs=120000]
   * @param {number} [opts.minRequestIntervalMs=500]
   */
  constructor(opts) {
    this.baseURL = opts.baseURL;
    this.maxRetries = opts.maxRetries ?? 4;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 120000;
    this.limiter = new RateLimiter(opts.minRequestIntervalMs ?? 500);
    this.axios = axios.create({ baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 30000 });
  }

  /**
   * Perform a request. Returns { status, data, headers }.
   * Throws FlopError with code/status/retryable on failure.
   * `responseType: 'stream'` is supported for SSE endpoints.
   */
  async request({ method, path, data = undefined, params = undefined, headers = {}, timeoutMs = undefined, responseType = undefined }) {
    await this.limiter.acquire();
    const started = Date.now();
    const op = async () => {
      try {
        const res = await this.axios.request({
          method, url: path, data, params, headers,
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
          ...(responseType ? { responseType } : {}),
        });
        logger.debug('HTTP ok', { method, path, status: res.status, ms: Date.now() - started });
        return { status: res.status, data: res.data, headers: res.headers };
      } catch (err) {
        throw this.#toFlopError(err, method, path, started);
      }
    };
    return withRetry(op, { retries: this.maxRetries, baseMs: this.retryBaseMs, maxRetryAfterMs: this.maxRetryAfterMs });
  }

  #toFlopError(err, method, path, started) {
    const ms = Date.now() - started;
    if (err.response) {
      const { status, data, headers } = err.response;
      const retryAfterMs = parseRetryAfter(headers?.['retry-after']);
      const detail = data && typeof data === 'object'
        ? (data.message ?? data.error ?? data.detail ?? null)
        : (typeof data === 'string' && data.length < 300 ? data : null);
      const message = `HTTP ${status} ${method} ${path}${detail ? `: ${detail}` : ''}`;
      logger.warn('HTTP error', { method, path, status, ms });
      return new FlopError(
        status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR',
        message,
        { status, retryable: isRetryableStatus(status), retryAfterMs },
      );
    }
    const message = `Network error ${method} ${path}: ${err.code ?? err.message}`;
    logger.warn('HTTP network error', { method, path, code: err.code ?? null, ms });
    return new FlopError('NETWORK_ERROR', message, { retryable: isRetryableAxiosError(err), cause: err });
  }
}
