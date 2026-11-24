/**
 * Inference runner — OpenAI-compatible POST /v1/chat/completions.
 *
 * Verified behaviour (devnet, 2026-11-24):
 *  - Non-streaming calls can hang past 120s and time out with 0 bytes.
 *  - Streaming can return HTTP 200 after ~200s and end in a provider_error
 *    ("no valid miner-signed standing offer for consented channel opening")
 *    with usage { prompt_tokens, completion_tokens: 0 }.
 *  - The gateway reports usage with header x_flop_usage_source: "estimated".
 *
 * Consequences, enforced here:
 *  - Long, configurable timeouts; every outcome (completed / failed / error /
 *    timeout) is recorded with its request id, duration, and usage.
 *  - Usage is labelled exactly as the gateway labels it (usually "estimated").
 *  - Settlement is NEVER claimed as verified: no official settlement endpoint
 *    exists, so every run records settled=false with the reason
 *    "no official settlement endpoint". The tracker/dashboard surface this
 *    honestly as estimated/unverified, never as verified spend.
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from './http.js';
import { FlopError, ValidationError } from './errors.js';
import { requireNonEmptyString, requirePositiveInt } from './validate.js';
import { logger } from './logger.js';

export const SETTLEMENT_UNVERIFIED_REASON = 'no official settlement endpoint';

/** Settlement check against official data only. Today there is no such endpoint. */
export function verifySettlement() {
  return {
    settled: false,
    source: 'none',
    reason: SETTLEMENT_UNVERIFIED_REASON,
    note: 'No official settlement endpoint exists for FLOP inference; usage figures from the gateway are estimates until one is published.',
  };
}

/**
 * Parse a Server-Sent Events byte stream into { text, usage, error }.
 * Handles `data: {...}` lines, `[DONE]`, and error payloads.
 */
export async function parseSseStream(stream, { onChunk = null } = {}) {
  let buffer = '';
  let text = '';
  let usage = null;
  let error = null;
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // keepalive / non-JSON frame; ignore
      }
      if (json.usage) usage = json.usage;
      if (json.error) {
        error = {
          code: json.error.code ?? 'provider_error',
          message: json.error.message ?? 'Provider error',
          type: json.error.type ?? null,
        };
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
      if (delta) {
        text += delta;
        if (onChunk) onChunk(delta);
      }
    }
  }
  return { text, usage, error };
}

export class InferenceRunner {
  /**
   * @param {object} opts
   * @param {HttpClient} [opts.http]
   * @param {string} [opts.baseURL] gateway base URL (…/v1)
   * @param {object} [opts.httpOptions]
   * @param {number} [opts.timeoutMs=300000]
   */
  constructor(opts) {
    this.timeoutMs = opts.timeoutMs ?? 300000;
    this.http = opts.http ?? new HttpClient({
      baseURL: opts.baseURL,
      timeoutMs: this.timeoutMs,
      ...(opts.httpOptions ?? {}),
    });
  }

  /**
   * Run one inference request.
   * @param {object} opts
   * @param {string} opts.apiKey gateway Bearer key (never logged)
   * @param {string} opts.model e.g. 'qwen/qwen2.5-0.5b-instruct'
   * @param {Array<{role: string, content: string}>} opts.messages
   * @param {number} [opts.maxTokens]
   * @param {boolean} [opts.stream=false]
   * @param {function} [opts.onChunk] streaming text callback
   * @returns {Promise<object>} run record (safe to store/log; contains no key)
   */
  async run({ apiKey, model, messages, maxTokens = undefined, stream = false, onChunk = null }) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new ValidationError('Inference requires a gateway API key (enroll first)');
    }
    requireNonEmptyString(model, 'model');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError('messages must be a non-empty array of {role, content}');
    }
    for (const m of messages) {
      requireNonEmptyString(m?.role, 'message.role');
      requireNonEmptyString(m?.content, 'message.content');
    }
    if (maxTokens !== undefined) requirePositiveInt(maxTokens, 'maxTokens');

    const requestId = randomUUID();
    const started = Date.now();
    const body = { model, messages, ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}), stream };
    let status = 'failed';
    let text = '';
    let usage = null;
    let usageSource = 'unknown';
    let error = null;
    let responseRequestId = null;

    try {
      const res = await this.http.request({
        method: 'POST',
        path: '/chat/completions',
        data: body,
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: this.timeoutMs,
        responseType: stream ? 'stream' : undefined,
      });
      responseRequestId = res.headers?.['x-request-id'] ?? res.headers?.['request-id'] ?? null;
      usageSource = res.headers?.['x_flop_usage_source'] ?? res.headers?.['x-flop-usage-source'] ?? 'unknown';
      if (stream) {
        const parsed = await parseSseStream(res.data, { onChunk });
        text = parsed.text;
        usage = parsed.usage;
        error = parsed.error;
        status = error ? 'error' : 'completed';
      } else {
        const data = res.data ?? {};
        if (data.error) {
          error = { code: data.error.code ?? 'provider_error', message: data.error.message ?? 'Provider error', type: data.error.type ?? null };
          status = 'error';
        } else {
          text = data.choices?.[0]?.message?.content ?? '';
          usage = data.usage ?? null;
          status = 'completed';
        }
      }
    } catch (err) {
      if (err instanceof FlopError && err.code === 'NETWORK_ERROR' && /timeout|aborted/i.test(err.message)) {
        status = 'timeout';
        error = { code: 'timeout', message: `Inference timed out after ${this.timeoutMs}ms with no response`, type: null };
      } else if (err instanceof FlopError) {
        status = err.status === 429 ? 'error' : 'failed';
        error = { code: err.code, message: err.message, type: null };
      } else {
        status = 'failed';
        error = { code: 'UNKNOWN', message: String(err?.message ?? err), type: null };
      }
    }

    const durationMs = Date.now() - started;
    const settlement = verifySettlement();
    const record = {
      id: requestId,
      createdAt: new Date(started).toISOString(),
      model,
      requestId: responseRequestId ?? requestId,
      status,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      usageSource: status === 'completed' || usage ? (usageSource === 'unknown' ? 'estimated' : usageSource) : 'unknown',
      settled: settlement.settled,
      settlementSource: settlement.source,
      settlementReason: settlement.reason,
      txRef: null, // no official tx reference is returned for inference today
      durationMs,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      text: status === 'completed' ? text : '',
    };
    logger.info('Inference run finished', {
      id: requestId, model, status, durationMs,
      promptTokens: record.promptTokens, completionTokens: record.completionTokens,
      usageSource: record.usageSource, settled: false,
    });
    return record;
  }
}
