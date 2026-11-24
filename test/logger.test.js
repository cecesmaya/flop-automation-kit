import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { Logger, redact, redactText } from '../src/logger.js';

class CollectingStream extends Writable {
  constructor() { super(); this.lines = []; }
  _write(chunk, _enc, cb) { this.lines.push(chunk.toString('utf8')); cb(); }
}

describe('logger redaction', () => {
  it('redacts a Bearer token in free text', () => {
    const out = redactText('Authorization: Bearer abcDEF1234567890xyz');
    assert.ok(!out.includes('abcDEF1234567890xyz'), out);
    assert.ok(out.includes('[REDACTED]'), out);
  });

  it('redacts a fake API key in free text', () => {
    const out = redactText('key is sk-test-abcdefgh12345678, keep it safe');
    assert.ok(!out.includes('sk-test-abcdefgh12345678'), out);
  });

  it('redacts a 128-hex-char signature but keeps a tx hash visible', () => {
    const sig = `0x${'ab'.repeat(64)}`;
    const tx = `0x${'cd'.repeat(32)}`;
    const out = redactText(`sig ${sig} tx ${tx}`);
    assert.ok(!out.includes(sig), 'signature must be redacted');
    assert.ok(out.includes(tx), 'tx hash is public data and stays visible');
  });

  it('redacts secret fields inside objects, keeps public fields and token counts', () => {
    const redacted = redact({
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      apiKey: 'fake-key-12345678',
      nested: { password: 'hunter2', amount: '25' },
      signature: `0x${'ff'.repeat(64)}`,
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
    });
    assert.equal(redacted.address, '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.nested.password, '[REDACTED]');
    assert.equal(redacted.nested.amount, '25');
    assert.equal(redacted.signature, '[REDACTED]');
    assert.equal(redacted.promptTokens, 8);
    assert.equal(redacted.completionTokens, 4);
    assert.equal(redacted.totalTokens, 12);
  });

  it('logger output never contains the secret', () => {
    const stream = new CollectingStream();
    const log = new Logger({ level: 'debug', stream });
    log.info('enrollment done', { apiKey: 'fake-secret-key-12345678', model: 'qwen/qwen2.5-0.5b-instruct' });
    log.info('Authorization: Bearer fake-bearer-token-abcdef123456');
    const joined = stream.lines.join('');
    assert.ok(!joined.includes('fake-secret-key-12345678'), joined);
    assert.ok(!joined.includes('fake-bearer-token-abcdef123456'), joined);
    assert.ok(joined.includes('qwen/qwen2.5-0.5b-instruct'), joined);
  });
});
