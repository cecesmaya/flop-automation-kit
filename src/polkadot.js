/**
 * Polkadot crypto bootstrap.
 *
 * @polkadot/util-crypto ships sr25519 as WASM; it must be initialised once
 * per process before any sr25519 operation. Every module that touches keys
 * awaits ensureCrypto() first.
 */
import { cryptoWaitReady } from '@polkadot/util-crypto';

let ready = null;

export function ensureCrypto() {
  if (!ready) ready = cryptoWaitReady();
  return ready;
}
