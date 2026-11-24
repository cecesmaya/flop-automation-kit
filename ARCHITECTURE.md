# Architecture

```
flop-automation-kit/
├── bin/flop.js            CLI entry (hand-rolled arg parsing, no framework)
├── src/
│   ├── config.js          env-based config, validated URLs/ints
│   ├── errors.js          FlopError + typed errors (code/status/retryable)
│   ├── logger.js          JSON logger with secret redaction (text + objects)
│   ├── polkadot.js        one-time WASM init (cryptoWaitReady)
│   ├── validate.js        SS58 validation via @polkadot/util-crypto
│   ├── http.js            axios + retry/backoff + Retry-After + rate limiter
│   ├── keystore.js        scrypt + AES-256-GCM envelope, 0600 files
│   ├── identity.js        sr25519 agent identity lifecycle
│   ├── faucet.js          official faucet API (limits/chain/health/fund)
│   ├── gateway.js         enroll challenge/sign/submit, models, key storage
│   ├── inference.js       OpenAI-compatible chat completions + SSE parsing
│   ├── hermes.js          provider setup/health checks (no invented URLs)
│   ├── tracker.js         node:sqlite records + JSON/CSV export
│   ├── dashboard.js       static HTML report (estimated vs verified split)
│   └── index.js           public module surface
└── test/                  node:test suites, mock HTTP servers only
```

## Design principles

1. **Official surfaces only.** Every network call goes to a URL from
   `.env` (devnet defaults, verified 2026-11-24). No third-party endpoints,
   no scraped pages, no browser automation — the faucet's documented HTTP
   API works, so Playwright was deliberately omitted.
2. **Secrets are data, never text.** Keys live in 0600 files; the logger
   redacts by field name and by pattern; HTTP logging is metadata-only
   (method, path, status, duration) — never headers or bodies.
3. **Failures are first-class records.** A timed-out inference or a
   provider error is stored as a run with status `timeout`/`error`, not
   retried silently and not counted as spend. Inference is never retried
   automatically: a retry could double-spend quota.
4. **Estimated ≠ verified, everywhere.** Usage from the gateway carries
   `usage_source` (`estimated` when the gateway says so). Settlement is a
   separate field that is only ever `true` when official data confirms it;
   today `verifySettlement()` always returns `settled: false` with the
   reason `no official settlement endpoint`.
5. **Retry policy.** Retries apply to idempotent reads and to the faucet
   `POST /fund` only within the server's own rules (429 with a short
   Retry-After). A `Retry-After` longer than `FLOP_MAX_RETRY_AFTER_MS`
   (default 120s) is a terminal error, not a long sleep — a 24h faucet
   cooldown surfaces as `FAUCET_COOLDOWN` immediately.
6. **No invention.** The Hermes module reports `not-configured` when no
   provider binary/endpoint is set. No download URL is fabricated.

## Data flow

```
identity generate ──> keystore/<name>.json (0600, scrypt+AES-256-GCM)
faucet claim      ──> POST faucet.flop.network/fund ──> tracker: faucet_claims
gateway enroll    ──> GET challenge ──> sr25519 sign ──> POST /enroll/wallet
                     ──> keystore/gateway.key (0600) ──> tracker: gateway_enrollments
inference run     ──> POST api.flop.network/v1/chat/completions (Bearer key)
                     ──> tracker: inference_runs (usage_source, settled=false)
tracker export    ──> JSON / CSV
dashboard         ──> data/dashboard.html (static, optional localhost serve)
```

## Storage

- `keystore/*.json` — encrypted identities (0600).
- `keystore/gateway.key` — gateway API key (0600).
- `data/activity.db` — SQLite: `inference_runs`, `faucet_claims`,
  `gateway_enrollments`. Created on first use.
- `data/dashboard.html`, `data/export*.json|csv` — generated reports.

## Testing

`npm test` runs `node --test test/`. All network tests use local mock HTTP
servers on 127.0.0.1 — no live calls. Coverage includes: keystore
round-trip + wrong-password failure, SS58 validation, logger redaction,
retry/backoff (incl. Retry-After cap), tracker insert/query/export, faucet
success/cooldown/challenge handling, gateway enrollment with a real
sr25519 signature verified server-side, and inference SSE provider-error
handling.
