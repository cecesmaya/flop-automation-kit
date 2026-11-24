import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Faucet } from '../src/faucet.js';
import { HttpClient } from '../src/http.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'; // Alice, valid ss58

describe('faucet (mock server)', () => {
  let server;
  let port;
  let mode = 'ok';
  let fundHits = 0;

  before(async () => {
    ({ server, port } = await startServer((req, res) => {
      const json = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/limits') return json(200, { anonymous: { grant: '25', cooldownSeconds: 86400 }, dailyCap: '10000000' });
      if (req.method === 'GET' && req.url === '/chain') return json(200, { name: 'FLOP Devnet', genesis: '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631', ss58Format: 42, decimals: 18, symbol: 'FLOP' });
      if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
      if (req.method === 'POST' && req.url === '/fund') {
        fundHits += 1;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.equal(parsed.client, 'flop-llms-txt');
          assert.equal(parsed.address, ADDRESS);
          if (mode === 'cooldown') return json(429, { error: 'cooldown active' }, { 'Retry-After': '86400' });
          if (mode === 'captcha') return json(200, { challenge: true, verificationUrl: 'https://example.invalid/verify' });
          return json(200, { amount: '25', txHash: `0x${'ab'.repeat(32)}`, tier: 'anonymous', status: 'included' });
        });
        return;
      }
      res.writeHead(404); res.end();
    }));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  function faucet() {
    return new Faucet({
      http: new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 0, minRequestIntervalMs: 0 }),
      client: 'flop-llms-txt',
      ss58Format: 42,
    });
  }

  it('reads limits, chain, and health', async () => {
    const f = faucet();
    const limits = await f.limits();
    assert.equal(limits.anonymous.grant, '25');
    const chain = await f.chain();
    assert.equal(chain.ss58Format, 42);
    assert.equal(chain.symbol, 'FLOP');
    const health = await f.health();
    assert.equal(health.status, 'ok');
  });

  it('claims a grant and returns amount + tx hash', async () => {
    mode = 'ok';
    const before = fundHits;
    const result = await faucet().claim(ADDRESS);
    assert.equal(fundHits, before + 1);
    assert.equal(result.address, ADDRESS);
    assert.equal(result.amount, '25');
    assert.equal(result.tier, 'anonymous');
    assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
  });

  it('rejects an invalid address before any HTTP request', async () => {
    const before = fundHits;
    await assert.rejects(() => faucet().claim('not-an-address'), /well-formed/);
    assert.equal(fundHits, before);
  });

  it('maps a 429 + 24h Retry-After to a cooldown error, without waiting', async () => {
    mode = 'cooldown';
    await assert.rejects(() => faucet().claim(ADDRESS), (err) => {
      assert.equal(err.code, 'FAUCET_COOLDOWN');
      assert.equal(err.retryable, false);
      return true;
    });
    mode = 'ok';
  });

  it('refuses to proceed when the faucet presents a verification challenge', async () => {
    mode = 'captcha';
    await assert.rejects(() => faucet().claim(ADDRESS), (err) => {
      assert.equal(err.code, 'MANUAL_ACTION_REQUIRED');
      return true;
    });
    mode = 'ok';
  });
});
