/**
 * Agent identity: a fresh sr25519 keypair per agent, stored only as an
 * encrypted keystore. Nothing here ever returns a seed or private key to a
 * caller that does not already hold the password, and nothing logs one.
 */
import { mnemonicGenerate, mnemonicToMiniSecret, encodeAddress } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encryptSeed, saveKeystore, loadKeystoreEnvelope, unlockKeystore } from './keystore.js';
import { ensureCrypto } from './polkadot.js';
import { ValidationError } from './errors.js';

/**
 * Generate a brand-new agent identity and persist its encrypted keystore.
 * @param {object} opts
 * @param {string} opts.password user-provided password (>= 8 chars)
 * @param {string} [opts.name='agent'] keystore file name (no path separators)
 * @param {string} [opts.dir] keystore directory
 * @param {number} [opts.ss58Format=42]
 * @returns {Promise<{name: string, address: string, publicKey: string, file: string, createdAt: string}>}
 */
export async function generateIdentity({ password, name = 'agent', dir, ss58Format = 42 }) {
  await ensureCrypto();
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new ValidationError('Identity name must be 1-64 chars: letters, digits, _ or -, starting alphanumerically');
  }
  const mnemonic = mnemonicGenerate(12);
  const seed = mnemonicToMiniSecret(mnemonic);
  const keyring = new Keyring({ type: 'sr25519', ss58Format });
  const pair = keyring.addFromSeed(seed);
  const address = encodeAddress(pair.publicKey, ss58Format);
  const envelope = await encryptSeed(seed, password, ss58Format);
  const file = await saveKeystore(dir, name, envelope);
  return { name, address, publicKey: envelope.publicKey, file, createdAt: envelope.createdAt };
}

/**
 * Public status of an identity: address, keystore file, creation time.
 * Never includes secrets. Returns null when no keystore exists at the path.
 */
export async function identityStatus(file) {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const envelope = await loadKeystoreEnvelope(file);
  const stat = await fs.stat(file);
  return {
    address: envelope.address,
    publicKey: envelope.publicKey,
    file: path.resolve(file),
    createdAt: envelope.createdAt ?? null,
    keystoreVersion: envelope.version ?? null,
    permissions: (stat.mode & 0o777).toString(8),
  };
}

/** Unlock an identity for signing. Returns the live pair (caller must not log it). */
export async function unlockIdentity(file, password, ss58Format = 42) {
  return unlockKeystore(file, password, ss58Format);
}

/** Default keystore path for an identity name inside the configured dir. */
export function identityFile(dir, name = 'agent') {
  return path.join(dir, `${name}.json`);
}
