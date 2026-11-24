/**
 * Dashboard — a static HTML report generated from tracker data.
 *
 * Two numbers are NEVER mixed:
 *  - "Estimated" — usage figures the gateway labelled estimated (or unknown).
 *  - "Verified" — figures confirmed by official settlement data. Today the
 *    official settlement source does not exist, so verified settled spend is
 *    always 0 and the page says so in plain words.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Tracker } from './tracker.js';
import { identityStatus } from './identity.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function buildDashboardHtml({ identity, summary, runs }) {
  const statusRows = Object.entries(summary.byStatus)
    .map(([status, n]) => `<tr><td>${esc(status)}</td><td>${n}</td></tr>`)
    .join('\n') || '<tr><td colspan="2">No inference runs recorded yet.</td></tr>';
  const runRows = runs.slice(0, 50).map((r) => `
    <tr>
      <td>${esc(r.created_at)}</td><td>${esc(r.model ?? '')}</td><td>${esc(r.status)}</td>
      <td>${r.total_tokens ?? '—'}</td><td>${esc(r.usage_source)}</td>
      <td>${r.settled ? 'yes' : 'no'}</td><td>${esc(r.error_code ?? '')}</td>
    </tr>`).join('\n') || '<tr><td colspan="7">No runs yet.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>FLOP Automation Kit — Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:2rem}
.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:.5rem 0}
.warn{background:#fff7e6;border-color:#d9a400}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.9rem}
.mono{font-family:monospace;word-break:break-all}
</style></head><body>
<h1>FLOP Automation Kit — Dashboard</h1>
<p>Generated ${esc(new Date().toISOString())}. Devnet-verified only; the FLOP testnet has not opened yet (Draft, Q4 2026).</p>

<h2>Agent identity</h2>
<div class="card">
${identity ? `
<p><strong>Address:</strong> <span class="mono">${esc(identity.address)}</span></p>
<p><strong>Keystore:</strong> <span class="mono">${esc(identity.file)}</span> (${esc(identity.permissions)})</p>
<p><strong>Created:</strong> ${esc(identity.createdAt ?? 'unknown')}</p>` : '<p>No identity keystore found. Run <code>flop identity generate</code>.</p>'}
</div>

<h2>Inference activity</h2>
<div class="card">
<p><strong>Total runs:</strong> ${summary.runs} &nbsp; <strong>Successful faucet claims:</strong> ${summary.successfulClaims}</p>
<table><tr><th>Status</th><th>Count</th></tr>${statusRows}</table>
</div>

<h2>Estimated vs verified</h2>
<div class="card warn">
<p><strong>Estimated tokens (gateway-reported, unverified):</strong> ${summary.estimatedTokens}</p>
<p><strong>Verified tokens (confirmed by official settlement data):</strong> ${summary.verifiedTokens}</p>
<p><strong>Verified settled runs:</strong> ${summary.settledRuns}</p>
<p>No official settlement endpoint exists for FLOP inference as of 2026-11-24, so verified settled spend is always 0. Usage figures from the gateway are estimates until an official settlement source is published. Nothing here is fabricated.</p>
</div>

<h2>Recent runs</h2>
<table><tr><th>Time</th><th>Model</th><th>Status</th><th>Tokens</th><th>Usage source</th><th>Settled</th><th>Error</th></tr>
${runRows}</table>
</body></html>
`;
}

/**
 * Generate the dashboard HTML file.
 * @returns {Promise<{file: string, summary: object}>}
 */
export async function generateDashboard({ dbFile, keystoreFile, outFile }) {
  const tracker = new Tracker(dbFile);
  let summary;
  let runs;
  try {
    summary = tracker.summary();
    runs = tracker.listRuns(50);
  } finally {
    tracker.close();
  }
  const identity = keystoreFile ? await identityStatus(keystoreFile) : null;
  const html = buildDashboardHtml({ identity, summary, runs });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, 'utf8');
  return { file: outFile, summary };
}
