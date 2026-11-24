import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { Tracker } from '../src/tracker.js';

describe('tracker', () => {
  const tracker = new Tracker(':memory:');
  after(() => tracker.close());

  it('records runs, claims, and enrollments; summary separates estimated from verified', () => {
    tracker.recordInferenceRun({
      id: 'run-1', createdAt: '2026-11-24T09:00:00.000Z', model: 'qwen/qwen2.5-0.5b-instruct',
      requestId: 'req-1', status: 'completed', promptTokens: 8, completionTokens: 4, totalTokens: 12,
      usageSource: 'estimated', settled: false, settlementSource: 'none',
      settlementReason: 'no official settlement endpoint', txRef: null, durationMs: 1200,
      errorCode: null, errorMessage: null,
    });
    tracker.recordInferenceRun({
      id: 'run-2', createdAt: '2026-11-24T09:01:00.000Z', model: 'qwen/qwen2.5-0.5b-instruct',
      requestId: 'req-2', status: 'error', promptTokens: 8, completionTokens: 0, totalTokens: 8,
      usageSource: 'estimated', settled: false, settlementSource: 'none',
      settlementReason: 'no official settlement endpoint', txRef: null, durationMs: 204000,
      errorCode: 'provider_error', errorMessage: 'no valid miner-signed standing offer for consented channel opening',
    });
    tracker.recordFaucetClaim({
      id: 'claim-1', createdAt: '2026-11-24T08:44:00.000Z',
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      status: 'completed', amount: '25', txHash: '0xdeadbeef', tier: 'anonymous',
    });
    tracker.recordEnrollment({
      id: 'enr-1', createdAt: '2026-11-24T08:48:00.000Z',
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      model: 'qwen/qwen2.5-0.5b-instruct', remainingQuota: 100,
      expiresAt: '2026-11-25T08:48:00.000Z', status: 'completed',
    });

    const summary = tracker.summary();
    assert.equal(summary.runs, 2);
    assert.deepEqual(summary.byStatus, { completed: 1, error: 1 });
    assert.equal(summary.totalTokens, 20);
    assert.equal(summary.estimatedTokens, 20);
    assert.equal(summary.verifiedTokens, 0);
    assert.equal(summary.settledRuns, 0);
    assert.equal(summary.successfulClaims, 1);

    const runs = tracker.listRuns();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, 'run-2'); // newest first
  });

  it('exports JSON with all tables and CSV with a header row', () => {
    const json = tracker.exportJson();
    assert.equal(json.inferenceRuns.length, 2);
    assert.equal(json.faucetClaims.length, 1);
    assert.equal(json.gatewayEnrollments.length, 1);
    assert.equal(json.summary.runs, 2);

    const csv = tracker.exportCsv('inference_runs');
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 3); // header + 2 rows
    assert.ok(lines[0].includes('id,created_at,model'), lines[0]);
    assert.ok(lines[1].includes('provider_error'), lines[1]);

    const claimsCsv = tracker.exportCsv('faucet_claims');
    assert.ok(claimsCsv.includes('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'));
  });

  it('rejects an unknown CSV table', () => {
    assert.throws(() => tracker.exportCsv('no_such_table'), /Unknown table/);
  });
});
