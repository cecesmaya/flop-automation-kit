import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signatureVerify, decodeAddress } from '@polkadot/util-crypto';

import { Gateway } from '../src/gateway.js';
import { HttpClient } from '../src/http.js';
import { generateIdentity, unlockIdentity } from '../src/identity.js';
import { ensureCrypto } from '../src/polkadot.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('gateway enrollment (mock server)', () => {
  let server;
  let port;
  let identity;
  let seenSignatureValid = null;

  before(async () => {
    await ensureCrypto();
    const dir = mkdtempSync(path.join(tmpdir(), 'flop-gw-'));
    identity = await generateIdentity({ password: 'correct horse battery staple', name: 'agent', dir, ss58Format: 42 });
    ({ server, port } = await startServer((req, res) => {
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url.startsWith('/enroll/wallet/challenge')) {
        return json(200, {
          message: 'Sign this message to enroll your wallet. Nonce: test-nonce-1',
          nonce: 'test-nonce-1',
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      }
      if (req.method === 'GET' && req.url === '/models') {
        return json(200, [{ id: 'qwen/qwen2.5-0.5b-instruct', context_length: 32768 }]);
      }
      if (req.method === 'POST' && req.url === '/enroll/wallet') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const publicKey = decodeAddress(parsed.address);
          const { isValid } = signatureVerify(parsed.message, parsed.signature, publicKey);
          seenSignatureValid = isValid;
          if (!isValid) return json(401, { error: 'bad signature' });
          return json(200, {
            apiKey: 'mock-gateway-key-12345678',
            model: 'qwen/qwen2.5-0.5b-instruct',
            remaining_quota: 100,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
        });
        return;
      }
      res.writeHead(404); res.end();
    }));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  function gateway() {
    return new Gateway({
      http: new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 0, minRequestIntervalMs: 0 }),
    });
  }

  it('enrolls a real unlocked identity with a verifiable sr25519 signature', async () => {
    const { pair, address } = await unlockIdentity(identity.file, 'correct horse battery staple', 42);
    const record = await gateway().enrollPair(pair, address);
    assert.equal(seenSignatureValid, true);
    assert.equal(record.apiKey, 'mock-gateway-key-12345678');
    assert.equal(record.model, 'qwen/qwen2.5-0.5b-instruct');
    assert.equal(record.remainingQuota, 100);
    assert.equal(record.address, identity.address);
  });

  it('lists models without auth', async () => {
    const models = await gateway().listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'qwen/qwen2.5-0.5b-instruct');
  });
});
