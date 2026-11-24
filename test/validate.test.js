import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicGenerate, mnemonicToMiniSecret, encodeAddress } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

import { validateSs58Address, isValidSs58Address } from '../src/validate.js';
import { ensureCrypto } from '../src/polkadot.js';

async function freshAddress() {
  await ensureCrypto();
  const seed = mnemonicToMiniSecret(mnemonicGenerate(12));
  const keyring = new Keyring({ type: 'sr25519' });
  const pair = keyring.addFromSeed(seed);
  return encodeAddress(pair.publicKey, 42);
}

describe('SS58 validation', () => {
  it('accepts a real sr25519 address and returns its public key', async () => {
    const address = await freshAddress();
    const result = await validateSs58Address(address, 42);
    assert.equal(result.address, address);
    assert.match(result.publicKeyHex, /^0x[0-9a-f]{64}$/);
    assert.equal(result.wasNormalized, false);
  });

  it('rejects garbage and short strings', async () => {
    await assert.rejects(() => validateSs58Address('not-an-address', 42), /well-formed/);
    await assert.rejects(() => validateSs58Address('', 42), /well-formed/);
    await assert.rejects(() => validateSs58Address(null, 42), /well-formed/);
  });

  it('rejects an address with a broken checksum', async () => {
    const address = await freshAddress();
    const last = address.slice(-1);
    const broken = address.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    await assert.rejects(() => validateSs58Address(broken, 42), /checksum/);
  });

  it('isValidSs58Address returns false instead of throwing', async () => {
    assert.equal(await isValidSs58Address('garbage', 42), false);
    const address = await freshAddress();
    assert.equal(await isValidSs58Address(address, 42), true);
  });
});
