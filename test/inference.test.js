import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { InferenceRunner } from '../src/inference.js';
import { HttpClient } from '../src/http.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('inference runner (mock server)', () => {
  let server;
  let port;
  let mode = 'stream-error';

  before(async () => {
    ({ server, port } = await startServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/chat/completions') {
        res.writeHead(404); res.end(); return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(req.headers.authorization, 'Bearer mock-key-123');
        assert.equal(parsed.model, 'qwen/qwen2.5-0.5b-instruct');
        if (mode === 'stream-error') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'x_flop_usage_source': 'estimated',
            'x-request-id': 'req-test-1',
          });
          res.write(': keepalive\n\n');
          res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
          res.write('data: {"error":{"code":"provider_error","message":"Error: no valid miner-signed standing offer for consented channel opening","type":"server_error"},"usage":{"prompt_tokens":8,"completion_tokens":0,"total_tokens":8}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        // non-streaming success
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x_flop_usage_source': 'estimated',
          'x-request-id': 'req-test-2',
        });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello world' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    }));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  function runner() {
    return new InferenceRunner({
      http: new HttpClient({ baseURL: `http://127.0.0.1:${port}`, timeoutMs: 5000, maxRetries: 0, minRequestIntervalMs: 0 }),
      timeoutMs: 5000,
    });
  }

  it('records a streaming provider_error as error with estimated usage, never verified', async () => {
    mode = 'stream-error';
    const record = await runner().run({
      apiKey: 'mock-key-123',
      model: 'qwen/qwen2.5-0.5b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(record.status, 'error');
    assert.equal(record.errorCode, 'provider_error');
    assert.match(record.errorMessage, /no valid miner-signed standing offer/);
    assert.equal(record.promptTokens, 8);
    assert.equal(record.completionTokens, 0);
    assert.equal(record.totalTokens, 8);
    assert.equal(record.usageSource, 'estimated');
    assert.equal(record.settled, false);
    assert.equal(record.settlementSource, 'none');
    assert.equal(record.settlementReason, 'no official settlement endpoint');
    assert.equal(record.requestId, 'req-test-1');
    assert.equal(record.text, '');
  });

  it('records a successful non-streaming run with estimated usage', async () => {
    mode = 'json-ok';
    const record = await runner().run({
      apiKey: 'mock-key-123',
      model: 'qwen/qwen2.5-0.5b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    assert.equal(record.status, 'completed');
    assert.equal(record.text, 'hello world');
    assert.equal(record.totalTokens, 8);
    assert.equal(record.usageSource, 'estimated');
    assert.equal(record.settled, false);
    assert.equal(record.requestId, 'req-test-2');
  });

  it('rejects a run without an API key', async () => {
    await assert.rejects(
      () => runner().run({ apiKey: '', model: 'qwen/qwen2.5-0.5b-instruct', messages: [{ role: 'user', content: 'hi' }] }),
      /requires a gateway API key/,
    );
  });
});
