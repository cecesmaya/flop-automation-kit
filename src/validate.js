/**
 * Input validation.
 *
 * SS58 addresses are validated with @polkadot/util-crypto (decode + re-encode
 * under the configured chain prefix) — never with a hand-rolled regex alone.
 */
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { ValidationError } from './errors.js';
import { ensureCrypto } from './polkadot.js';

/** Base58 alphabet used by SS58; a quick shape check before crypto work. */
const SS58_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/**
 * Validate an SS58 address and normalise it to the configured chain prefix.
 * @returns {Promise<{address: string, publicKeyHex: string, wasNormalized: boolean}>}
 * @throws {ValidationError} on any malformed input
 */
export async function validateSs58Address(address, ss58Format = 42) {
  await ensureCrypto();
  if (typeof address !== 'string' || !SS58_SHAPE.test(address.trim())) {
    throw new ValidationError(`Not a well-formed SS58 address: ${String(address).slice(0, 24)}`);
  }
  const trimmed = address.trim();
  let publicKey;
  try {
    publicKey = decodeAddress(trimmed);
  } catch {
    throw new ValidationError(`SS58 address failed checksum/decode: ${trimmed.slice(0, 24)}`);
  }
  const normalized = encodeAddress(publicKey, ss58Format);
  return {
    address: normalized,
    publicKeyHex: `0x${Buffer.from(publicKey).toString('hex')}`,
    wasNormalized: normalized !== trimmed,
  };
}

/** True when the value looks like a usable SS58 address (no throw). */
export async function isValidSs58Address(address, ss58Format = 42) {
  try {
    await validateSs58Address(address, ss58Format);
    return true;
  } catch {
    return false;
  }
}

export function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function requirePositiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer, got: ${value}`);
  }
  return n;
}

export function requireUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new ValidationError(`${field} must be a valid http(s) URL, got: ${value}`);
  }
}
