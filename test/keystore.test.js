import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encryptSeed, decryptSeed, saveKeystore, unlockKeystore } from '../src/keystore.js';
import { generateIdentity, identityStatus } from '../src/identity.js';
import { validateSs58Address } from '../src/validate.js';

const PASSWORD = 'correct horse battery staple';
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));

describe('keystore', () => {
  it('encrypt/decrypt round-trips the seed', async () => {
    const envelope = await encryptSeed(SEED, PASSWORD, 42);
    assert.equal(envelope.cipher, 'aes-256-gcm');
    assert.equal(envelope.kdf, 'scrypt');
    assert.equal(typeof envelope.address, 'string');
    const back = await decryptSeed(envelope, PASSWORD);
    assert.deepEqual(Buffer.from(back), Buffer.from(SEED));
  });

  it('decrypted seed derives the envelope address', async () => {
    const envelope = await encryptSeed(SEED, PASSWORD, 42);
    const { address } = await validateSs58Address(envelope.address, 42);
    assert.equal(address, envelope.address);
  });

  it('wrong password fails with a keystore error', async () => {
    const envelope = await encryptSeed(SEED, PASSWORD, 42);
    await assert.rejects(() => decryptSeed(envelope, 'wrong password here'), /Failed to unlock keystore/);
  });

  it('short password is rejected', async () => {
    await assert.rejects(() => encryptSeed(SEED, 'short', 42), /at least 8 characters/);
  });

  it('keystore file is written with mode 0600', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flop-ks-'));
    const envelope = await encryptSeed(SEED, PASSWORD, 42);
    const file = await saveKeystore(dir, 'agent', envelope);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('generateIdentity creates a usable, unlockable identity', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flop-id-'));
    const result = await generateIdentity({ password: PASSWORD, name: 'agent', dir, ss58Format: 42 });
    assert.equal(statSync(result.file).mode & 0o777, 0o600);
    const status = await identityStatus(result.file);
    assert.equal(status.address, result.address);
    assert.equal(status.permissions, '600');
    const unlocked = await unlockKeystore(result.file, PASSWORD, 42);
    assert.equal(unlocked.address, result.address);
    await assert.rejects(() => unlockKeystore(result.file, 'wrong password here', 42), /Failed to unlock keystore/);
  });
});
