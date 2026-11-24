/**
 * Error types for flop-automation-kit.
 *
 * Every error carries a stable machine-readable `code`, a human-readable
 * message, an HTTP `status` when one applies, and a `retryable` flag so
 * callers (and the retry helper) never have to guess from message text.
 */

export class FlopError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. 'FAUCET_RATE_LIMITED'
   * @param {string} message human-readable message (must not contain secrets)
   * @param {object} [opts]
   * @param {number} [opts.status] HTTP status when the error came from an API
   * @param {boolean} [opts.retryable=false]
   * @param {number} [opts.retryAfterMs] milliseconds to wait before retrying (from Retry-After)
   * @param {Error} [opts.cause]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'FlopError';
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    if (opts.cause) this.cause = opts.cause;
  }
}

export class ValidationError extends FlopError {
  constructor(message, opts = {}) {
    super('VALIDATION_ERROR', message, { ...opts, retryable: false });
    this.name = 'ValidationError';
  }
}

export class KeystoreError extends FlopError {
  constructor(message, opts = {}) {
    super('KEYSTORE_ERROR', message, { ...opts, retryable: false });
    this.name = 'KeystoreError';
  }
}

export class ConfigError extends FlopError {
  constructor(message, opts = {}) {
    super('CONFIG_ERROR', message, { ...opts, retryable: false });
    this.name = 'ConfigError';
  }
}
