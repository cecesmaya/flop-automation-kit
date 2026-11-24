/**
 * Activity tracker — node:sqlite (built-in, no native build).
 *
 * Three tables:
 *  - inference_runs: every inference attempt, with usage source and
 *    settlement state (settled is only ever true when official data says so;
 *    today it is always false — see inference.js).
 *  - faucet_claims: every faucet claim attempt.
 *  - gateway_enrollments: every enrollment attempt.
 * Exports: JSON (all tables + summary) and CSV (one table at a time).
 */
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inference_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT,
  request_id TEXT,
  status TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  usage_source TEXT NOT NULL DEFAULT 'unknown',
  settled INTEGER NOT NULL DEFAULT 0,
  settlement_source TEXT,
  settlement_reason TEXT,
  tx_ref TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT
);
CREATE TABLE IF NOT EXISTS faucet_claims (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  amount TEXT,
  tx_hash TEXT,
  tier TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE TABLE IF NOT EXISTS gateway_enrollments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  address TEXT NOT NULL,
  model TEXT,
  remaining_quota REAL,
  expires_at TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON inference_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_claims_created ON faucet_claims (created_at);
`;

export class Tracker {
  /** @param {string} file path to the SQLite file; use ':memory:' for tests */
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  recordInferenceRun(run) {
    const stmt = this.db.prepare(`
      INSERT INTO inference_runs
      (id, created_at, model, request_id, status, prompt_tokens, completion_tokens,
       total_tokens, usage_source, settled, settlement_source, settlement_reason,
       tx_ref, duration_ms, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.id, run.createdAt, run.model ?? null, run.requestId ?? null, run.status,
      run.promptTokens ?? null, run.completionTokens ?? null, run.totalTokens ?? null,
      run.usageSource ?? 'unknown', run.settled ? 1 : 0,
      run.settlementSource ?? null, run.settlementReason ?? null, run.txRef ?? null,
      run.durationMs ?? null, run.errorCode ?? null, run.errorMessage ?? null,
    );
    return run.id;
  }

  recordFaucetClaim(claim) {
    const stmt = this.db.prepare(`
      INSERT INTO faucet_claims
      (id, created_at, address, status, amount, tx_hash, tier, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      claim.id, claim.createdAt, claim.address, claim.status,
      claim.amount ?? null, claim.txHash ?? null, claim.tier ?? null,
      claim.errorCode ?? null, claim.errorMessage ?? null,
    );
    return claim.id;
  }

  recordEnrollment(enrollment) {
    const stmt = this.db.prepare(`
      INSERT INTO gateway_enrollments
      (id, created_at, address, model, remaining_quota, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      enrollment.id, enrollment.createdAt, enrollment.address,
      enrollment.model ?? null, enrollment.remainingQuota ?? null,
      enrollment.expiresAt ?? null, enrollment.status,
    );
    return enrollment.id;
  }

  listRuns(limit = 100) {
    return this.db.prepare('SELECT * FROM inference_runs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  listClaims(limit = 100) {
    return this.db.prepare('SELECT * FROM faucet_claims ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  listEnrollments(limit = 100) {
    return this.db.prepare('SELECT * FROM gateway_enrollments ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  summary() {
    const counts = this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM inference_runs GROUP BY status",
    ).all();
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    const totals = this.db.prepare(
      'SELECT COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS totalTokens, ' +
      "COALESCE(SUM(CASE WHEN usage_source = 'verified' THEN total_tokens ELSE 0 END), 0) AS verifiedTokens, " +
      "COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimatedTokens, " +
      'COALESCE(SUM(settled), 0) AS settledRuns FROM inference_runs',
    ).get();
    const claims = this.db.prepare('SELECT COUNT(*) AS n FROM faucet_claims WHERE status = ?').get('completed');
    return {
      runs: totals.runs,
      byStatus,
      totalTokens: totals.totalTokens,
      verifiedTokens: totals.verifiedTokens,
      estimatedTokens: totals.estimatedTokens,
      settledRuns: totals.settledRuns,
      successfulClaims: claims.n,
    };
  }

  exportJson() {
    return {
      exportedAt: new Date().toISOString(),
      summary: this.summary(),
      inferenceRuns: this.listRuns(1000),
      faucetClaims: this.listClaims(1000),
      gatewayEnrollments: this.listEnrollments(1000),
    };
  }

  exportCsv(table = 'inference_runs') {
    const allowed = { inference_runs: this.listRuns.bind(this), faucet_claims: this.listClaims.bind(this), gateway_enrollments: this.listEnrollments.bind(this) };
    const list = allowed[table];
    if (!list) throw new Error(`Unknown table for CSV export: ${table}`);
    const rows = list(1000);
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => csvCell(row[h])).join(','));
    }
    return `${lines.join('\n')}\n`;
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeExport(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}
