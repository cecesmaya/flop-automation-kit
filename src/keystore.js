/**
 * Secure keystore: scrypt + AES-256-GCM, files written 0600.
 *
 * The encrypted payload is the raw 32-byte sr25519 seed (hex). The address
 * and public key are stored in cleartext in the envelope — they are public.
 * The password is never stored, and a wrong password fails at the AES-GCM
 * authentication tag: the error message deliberately does not distinguish
 * "wrong password" from "corrupt file" beyond that.
 */
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { encodeAddress } from '@polkadot/util-crypto';
import { KeystoreError, ValidationError } from './errors.js';
import { ensureCrypto } from './polkadot.js';

const scrypt = promisify(scryptCb);

export const KEYSTORE_VERSION = 1;
export const KDF_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 };
export const MIN_PASSWORD_LENGTH = 8;

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Keystore password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

async function deriveKey(password, salt) {
  return scrypt(password, salt, KDF_PARAMS.keyLen, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Encrypt a 32-byte seed into a keystore envelope.
 * @param {Uint8Array} seed 32-byte sr25519 seed
 * @param {string} password user-provided password
 * @param {number} [ss58Format=42]
 * @returns {Promise<object>} envelope (JSON-serialisable, no secrets in cleartext)
 */
export async function encryptSeed(seed, password, ss58Format = 42) {
  await ensureCrypto();
  assertPassword(password);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new ValidationError('Seed must be a 32-byte Uint8Array');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ seed: `0x${Buffer.from(seed).toString('hex')}` });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Address is derived from the seed via the public key; computed here so the
  // envelope can be inspected (address only) without unlocking.
  const { Keyring } = await import('@polkadot/keyring');
  const keyring = new Keyring({ type: 'sr25519' });
  const pair = keyring.addFromSeed(seed);
  const address = encodeAddress(pair.publicKey, ss58Format);
  return {
    version: KEYSTORE_VERSION,
    kind: 'flop-automation-kit/keystore',
    address,
    publicKey: `0x${Buffer.from(pair.publicKey).toString('hex')}`,
    kdf: 'scrypt',
    kdfParams: { ...KDF_PARAMS },
    cipher: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Decrypt an envelope back to the seed.
 * @throws {KeystoreError} on wrong password or corrupt/tampered data
 */
export async function decryptSeed(envelope, password) {
  assertPassword(password);
  if (!envelope || envelope.version !== KEYSTORE_VERSION || envelope.cipher !== 'aes-256-gcm') {
    throw new KeystoreError('Unsupported or corrupt keystore envelope');
  }
  try {
    const key = await deriveKey(password, Buffer.from(envelope.salt, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    const seedHex = parsed.seed;
    if (typeof seedHex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error('bad payload');
    }
    return new Uint8Array(Buffer.from(seedHex.slice(2), 'hex'));
  } catch (err) {
    if (err instanceof KeystoreError) throw err;
    throw new KeystoreError('Failed to unlock keystore: wrong password or corrupt file', { cause: err });
  }
}

/** Write an envelope to disk with mode 0600 (directory 0700). */
export async function saveKeystore(dir, name, envelope) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name.endsWith('.json') ? name : `${name}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
  return file;
}

/** Read and parse a keystore envelope from disk. */
export async function loadKeystoreEnvelope(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new KeystoreError(`Cannot read keystore file: ${file}`, { cause: err });
  }
}

/** Unlock a keystore file into a live sr25519 pair. The pair is returned, never logged. */
export async function unlockKeystore(file, password, ss58Format = 42) {
  await ensureCrypto();
  const envelope = await loadKeystoreEnvelope(file);
  const seed = await decryptSeed(envelope, password);
  const { Keyring } = await import('@polkadot/keyring');
  const keyring = new Keyring({ type: 'sr25519', ss58Format });
  const pair = keyring.addFromSeed(seed);
  const address = encodeAddress(pair.publicKey, ss58Format);
  if (address !== envelope.address) {
    throw new KeystoreError('Keystore integrity check failed: derived address does not match envelope');
  }
  return { pair, address, publicKeyHex: envelope.publicKey, envelope };
}
