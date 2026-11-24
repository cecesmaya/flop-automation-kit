# Security policy

## What this kit does with secrets

- Agent identities are sr25519 keypairs. Only the **encrypted** keystore is
  ever written to disk (scrypt + AES-256-GCM, file mode `0600`, directory
  `0700`). The password is never stored.
- The gateway API key is written to a `0600` file and **never printed or
  logged**. The logger redacts Authorization headers, Bearer tokens, API
  keys, signatures, and secret-named object fields before any line is
  emitted. Redaction is a second line of defence — callers must still avoid
  passing secrets to the logger.
- `.gitignore` covers `.env`, `keystore/`, `data/*.db`, `*.key`, and
  `hermes.config.json`. If you ever find a real secret committed, rotate it
  immediately and purge it from history (`git filter-repo` or BFG).

## What this kit will never do

- **No CAPTCHA / anti-bot bypass.** If the faucet (or any official surface)
  presents a verification challenge, the kit stops with
  `MANUAL_ACTION_REQUIRED` and tells you to complete it in a browser. There
  is no code path that solves, skips, or works around such a challenge.
- **No fabricated activity.** Inference usage is recorded exactly as the
  gateway reports it, labelled `estimated` unless official data says
  otherwise. Settlement is reported as verified **only** when an official
  settlement source confirms it. Today no such source exists, so every run
  records `settled: false` with the reason `no official settlement endpoint`.
- **No invented endpoints or binaries.** The Hermes module never fabricates
  a download URL. If no provider binary/endpoint is configured it reports
  `not-configured` honestly.
- **No credential reuse.** The kit generates fresh identities only. It never
  reads, imports, or references key material from any other project or
  wallet, and it never asks for a seed phrase, private key, or password in
  chat or in a ticket.

## Reporting a vulnerability

Open a GitHub issue titled `[security]` with a minimal reproduction and no
real credentials. Do not include a keystore, password, or API key in any
report. Responsible disclosures that affect FLOP itself should also go to
the address published on the official FLOP testnet page
(`security@flop.finance` per the testnet page).

## Known limits (honest)

- The FLOP testnet has **not opened yet** (status Draft, opens Q4 2026).
  Everything in this kit is verified against the **devnet only** (2026-11-24).
  Devnet activity earns no airdrop weight.
- Devnet inference can fail when no miner serves a model (observed:
  `provider_error` — "no valid miner-signed standing offer for consented
  channel opening"). The runner records that as an `error` run; it does not
  hide it and does not count it as spend.
- A wrong keystore password fails at the AES-GCM authentication tag. There
  is no password recovery.
