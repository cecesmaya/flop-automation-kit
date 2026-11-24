# flop-automation-kit

A modular Node.js toolkit for FLOP Network testnet activities: agent identity
management, secure keystore storage, faucet interaction, gateway enrollment,
inference execution, and activity tracking — with an honest dashboard that
never confuses estimates with verified spend.

> **Status: devnet-verified only.** Everything below was verified against the
> FLOP **devnet** on 2026-11-24. The real FLOP **testnet has not opened yet**
> (status Draft, opens Q4 2026, mainnet Q1 2027). Devnet activity earns **no
> airdrop weight**. All endpoints are configurable via `.env` so the same code
> can move to the testnet when it opens.
>
> **Independent implementation.** This repository was built from the official
> FLOP documentation and verified API behaviour. It is not affiliated with
> FLOP Labs, and it is not a copy of any other community toolkit.

## What it does

| Module | What it does |
| --- | --- |
| Agent Identity | Generates a fresh sr25519 agent identity; stores it only as an encrypted keystore |
| Secure Keystore | scrypt + AES-256-GCM, user password, `0600` files, never committed |
| Faucet | Official faucet API: limits / chain / health / fund; SS58 validation; rate-limit + cooldown handling |
| Hermes Provider | Validates a configured provider (endpoint/binary); health-checks it; **never invents a download URL** |
| Inference Runner | OpenAI-compatible `/v1/chat/completions` (streaming + non-streaming); records request ids, usage, and errors |
| Activity Tracker | SQLite records (`inference_runs`, `faucet_claims`, `gateway_enrollments`); JSON + CSV export |
| Dashboard | Static HTML: identity status, activity, success/failure, and a clearly separated **estimated vs verified** section |

## Honest limits (read before use)

- **Inference may fail when no miners serve a model.** On devnet this was
  observed directly: streaming returns HTTP 200 after ~200s and ends in
  `provider_error` — *"no valid miner-signed standing offer for consented
  channel opening"* — with `completion_tokens: 0`. The runner records that
  as an `error` run. It does not hide it and does not count it as spend.
- **Settlement verification is estimated, not verified.** No official
  settlement endpoint exists for FLOP inference. Every run therefore records
  `settled: false` with the reason `no official settlement endpoint`, and
  the dashboard shows verified settled spend as **0** until an official
  source is published. Usage figures from the gateway carry
  `x_flop_usage_source: "estimated"` and are labelled as such.
- **Faucet grants are one per address per 24h** (25 FLOP on devnet). A claim
  during cooldown returns `FAUCET_COOLDOWN` immediately — the kit never
  waits out a 24h cooldown and never works around rate limits.
- **No CAPTCHA / anti-bot bypass, ever.** If the faucet presents a
  verification challenge, the kit stops with `MANUAL_ACTION_REQUIRED`.
- **A wrong keystore password cannot be recovered.** There is no reset flow.

## Quick start

```bash
node --version   # >= 22 required
npm install
cp .env.example .env   # edit only if you need non-default endpoints
```

### 1. Create an agent identity

```bash
export FLOP_KEYSTORE_PASSWORD='a-long-random-password'
node bin/flop.js identity generate --name my-agent
# -> keystore/my-agent.json (0600)
# -> address printed (public); the seed is never printed
```

Or enter the password interactively (it is prompted, never passed as a flag).

### 2. Claim test FLOP from the faucet

```bash
node bin/flop.js faucet limits
node bin/flop.js faucet claim --keystore keystore/my-agent.json
```

### 3. Enroll with the gateway and get an API key

```bash
node bin/flop.js gateway models
node bin/flop.js gateway enroll --keystore keystore/my-agent.json
# -> keystore/gateway.key (0600); the key is never printed
```

The enrollment signs the gateway's challenge message with the identity's
sr25519 key (SIWE-style, 5-minute expiry).

### 4. Run inference

```bash
node bin/flop.js inference run \
  --model qwen/qwen2.5-0.5b-instruct \
  --prompt "Hello, what is FLOP?" \
  --max-tokens 128
```

Add `--stream` to print tokens as they arrive. Every run is recorded in the
tracker with its status, usage, and settlement state.

### 5. Track and report

```bash
node bin/flop.js tracker export --format json --out data/export.json
node bin/flop.js tracker export --format csv --table inference_runs --out data/runs.csv
node bin/flop.js dashboard --out data/dashboard.html
node bin/flop.js dashboard --serve --port 8787   # http://127.0.0.1:8787
```

### 6. Hermes provider (optional)

```bash
node bin/flop.js hermes setup    # validates config; writes hermes.config.json example
node bin/flop.js hermes check    # health-checks a configured endpoint
```

No official Hermes provider binary URL is published/verified as of
2026-11-24, so `hermes setup` reports `not-configured` until you point it
at a real provider with `FLOP_HERMES_ENDPOINT` or `FLOP_HERMES_BINARY`
after verifying the source yourself.

## CLI reference

```
flop identity generate [--name <name>] [--dir <dir>]
flop identity status [--keystore <file>]
flop faucet limits | chain | health
flop faucet claim [--address <ss58> | --keystore <file>]
flop gateway enroll [--keystore <file>]
flop gateway models
flop inference run --model <m> --prompt <text> [--max-tokens <n>] [--stream]
flop hermes setup
flop hermes check
flop tracker export [--format json|csv] [--table <table>] [--out <file>]
flop dashboard [--out <file>] [--serve] [--port <n>]
flop --help | --version
```

## Configuration

See `.env.example` for every variable. The important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `FLOP_FAUCET_URL` | `https://faucet.flop.network` | Official faucet |
| `FLOP_GATEWAY_URL` | `https://api.flop.network` | Gateway API (`/v1`) |
| `FLOP_RPC_URL` | `https://rpc.devnet.flop.network` | Chain RPC (HTTP) |
| `FLOP_KEYSTORE_DIR` | `./keystore` | Encrypted identities |
| `FLOP_DATA_DIR` | `./data` | SQLite DB + reports |
| `FLOP_KEYSTORE_PASSWORD` | — | Or enter interactively |
| `FLOP_INFERENCE_TIMEOUT_MS` | `300000` | Devnet inference can take ~200s+ |
| `FLOP_MAX_RETRIES` | `4` | Not applied to inference runs |
| `FLOP_MAX_RETRY_AFTER_MS` | `120000` | Longer server waits become terminal errors |

## Verified endpoints (devnet, 2026-11-24)

- Faucet `GET /limits` — anonymous grant 25 FLOP/address/24h, cooldown 86400s.
- Faucet `GET /chain` — `FLOP Devnet`, genesis
  `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631`,
  ss58Format 42, 18 decimals.
- Faucet `GET /health`, `POST /fund` `{address, client}` — returns a grant
  with a tx hash.
- Gateway `GET /enroll/wallet/challenge?address=` — `{message, nonce,
  expires_at}` (5 min).
- Gateway `POST /enroll/wallet` — returns an API key scoped to one model
  plus `{remaining_quota, expires_at}` (verified: model
  `qwen/qwen2.5-0.5b-instruct`, quota 100 FLOP, key ~24h).
- Gateway `GET /v1/models` — no auth; lists models incl.
  `qwen/qwen2.5-0.5b-instruct` (context 32768, 0.000001 FLOP/token).
- Inference `POST /v1/chat/completions` — OpenAI-compatible, Bearer key.

## Development

```bash
npm test          # node:test suites, local mock servers only — no live calls
```

Modular layout, retry with exponential backoff + jitter, client-side rate
limiting, input validation, and structured JSON logging with secret
redaction. See [ARCHITECTURE.md](ARCHITECTURE.md) and
[SECURITY.md](SECURITY.md).

## Why no browser automation?

The faucet exposes a documented HTTP API (`POST /fund`) that works
directly, so Playwright/Puppeteer is unnecessary. Browser automation was
deliberately omitted: fewer dependencies, no anti-bot surface, and nothing
to maintain when the faucet UI changes.

## License

MIT — see [LICENSE](LICENSE).
