import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpClient, withRetry, parseRetryAfter } from '../src/http.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

describe('parseRetryAfter', () => {
  it('parses seconds and dates, returns null for junk', () => {
    assert.equal(parseRetryAfter('5'), 5000);
    assert.equal(parseRetryAfter('0'), 0);
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter('nonsense'), null);
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = parseRetryAfter(future);
    assert.ok(ms > 5000 && ms <= 10000, String(ms));
  });
});

describe('HttpClient retry behaviour', () => {
  let server;
  let port;
  let counts;

  before(async () => {
    counts = { flaky: 0, ratelimited: 0, always500: 0 };
    ({ server, port } = await startServer((req, res) => {
      if (req.url === '/flaky') {
        counts.flaky += 1;
        if (counts.flaky < 3) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (req.url === '/ratelimited') {
        counts.ratelimited += 1;
        if (counts.ratelimited === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end('{"error":"slow down"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (req.url === '/always500') {
        counts.always500 += 1;
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); return;
      }
      res.writeHead(404); res.end();
    }));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('retries a 500 twice, then succeeds', async () => {
    const client = new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 3, retryBaseMs: 10, minRequestIntervalMs: 0 });
    const res = await client.request({ method: 'GET', path: '/flaky' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true });
    assert.equal(counts.flaky, 3);
  });

  it('honours Retry-After: 0 on a 429 and retries', async () => {
    const client = new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 3, retryBaseMs: 10, minRequestIntervalMs: 0 });
    const res = await client.request({ method: 'GET', path: '/ratelimited' });
    assert.equal(res.status, 200);
    assert.equal(counts.ratelimited, 2);
  });

  it('gives up after max retries and reports the attempt count', async () => {
    const client = new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 2, retryBaseMs: 10, minRequestIntervalMs: 0 });
    await assert.rejects(() => client.request({ method: 'GET', path: '/always500' }), (err) => {
      assert.equal(err.code, 'SERVER_ERROR');
      assert.equal(err.status, 500);
      return true;
    });
    assert.equal(counts.always500, 3); // 1 initial + 2 retries
  });

  it('a huge Retry-After becomes a terminal error, not a long sleep', async () => {
    const delays = [];
    await assert.rejects(
      () => withRetry(
        () => Promise.reject(Object.assign(new Error('slow'), { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 86400000, status: 429 })),
        { retries: 3, baseMs: 10, maxRetryAfterMs: 120000, onRetry: ({ delayMs }) => delays.push(delayMs) },
      ),
      (err) => {
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
    assert.deepEqual(delays, []);
  });

  it('backoff grows exponentially', async () => {
    const delays = [];
    let attempts = 0;
    await assert.rejects(
      () => withRetry(
        () => { attempts += 1; return Promise.reject(Object.assign(new Error('x'), { code: 'SERVER_ERROR', retryable: true, retryAfterMs: null })); },
        { retries: 2, baseMs: 100, onRetry: ({ delayMs }) => delays.push(delayMs) },
      ),
      /x/,
    );
    assert.equal(attempts, 3);
    assert.ok(delays[1] > delays[0], `delays should grow: ${delays}`);
    assert.ok(delays[0] >= 100 && delays[0] < 400, `first delay ~100ms: ${delays[0]}`);
  });
});
