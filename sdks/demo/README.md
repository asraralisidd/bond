# BOND Agent Integration Demo

This document covers two entry points sharing the same SDK-only
integration boundary:

- `demo.py` — deterministic custom-agent integration (Phase 16.4):
  register → report → analyze → flags → status → verify.
- `ai_agent_demo.py` — end-to-end AI agent security demo (Phase 17):
  model → agent → SDK → API → risk → attestation → enforcement
  (SIMULATED). See "AI agent demo" below.

## Purpose

Demonstrates an external custom agent integrating with BOND through the
Python SDK (`bond_sdk`). No AI model, no model API keys, no live
Midnight — a scripted agent registers, reports activity, and reads
back risk results, status, and public verification.

## Architecture

Custom Agent
↓ (`sdks/demo/demo.py`, `DemoAgent`)
BOND Python SDK (`bond_sdk`: client, activity builder, errors)
↓ (HTTPS/JSON only — never raw sockets, DB, engine, or attestors)
BOND API
↓
Risk Engine (advisory analysis → flags)

## Prerequisites

- Repository dependencies: `npm install`
- PostgreSQL running (existing setup; no second database):
  `docker compose up -d db`
- Python 3.10+ with `httpx` and `pytest` available
- Python SDK importable: `pip install ./sdks/python` (or set
  `PYTHONPATH` to the repo root — `bond_sdk` lives at
  `sdks/python/bond_sdk`)

## Configuration

| Variable                | Default                 | Notes                                               |
| ----------------------- | ----------------------- | --------------------------------------------------- |
| `BOND_API_URL`          | `http://localhost:4000` | BOND API base URL                                   |
| `BOND_DEV_AUTH_TOKEN`   | _(required)_            | Local dev auth token (matches API `DEV_AUTH_TOKEN`) |
| `BOND_DEV_EXTERNAL_KEY` | `demo-operator`         | Operator identity for the dev session               |

No real secrets: use local development values only. Never commit a
token, never print one (the demo prints IDs, scores, counts, and
statuses — never tokens, headers, or credentials).

## Running

```bash
# 1. PostgreSQL
docker compose up -d db

# 2. Migrations (existing project scripts)
npm run db:migrate   # if required by your checkout

# 3. API
npm run dev:api

# 4. Auth env (example values only — use your local dev token)
export BOND_API_URL=http://localhost:4000
export BOND_DEV_AUTH_TOKEN=dev-change-me

# 5. Demo
python sdks/demo/demo.py
```

Expected output shape:

```
================================
BOND Agent Integration Demo
================================
[1/7] Connecting to BOND       ✓
[2/7] Registering agent        ✓
[3/7] Reporting activity 1/3   ✓
...
Agent ID: <safe identifier>
Analysis ID: <safe identifier>
Risk Score: <actual score>
Flags: <actual count>
Status: <actual status>
Verification: <actual result>
```

Failures print `demo failed: <CODE>: <message>` to stderr and exit 1.

## Flow

REGISTER → REPORT → ANALYZE → FLAGS → STATUS → VERIFY

1. Health check (connectivity).
2. Dev session auth (token stays inside the SDK client).
3. Deterministic registration (`bond-demo` / `custom` /
   `demo-agent-v1`); reruns reuse the existing agent via the server's
   duplicate-triple guard.
4. Three scripted activities (message, tool-call, transfer) built with
   the SDK `ActivityBuilder`; each analysis ID/score/flag IDs captured.
5. Flag listing, agent status read, unauthenticated public
   verification (scoped projection only).

## What is real

Everything the demo touches is genuinely executed against the local
API: registration, activity ingestion, risk analysis, flag reads,
status reads, and public verification. Printed scores/counts/statuses
are actual server responses.

## What is simulated

Nothing in the demo flow is simulated: it performs no blockchain,
wallet, or proving operations at all. Bond _collateral locking on
chain_ (as opposed to the bond record API) requires Midnight/wallet
infrastructure and is intentionally out of scope — the demo creates no
bond and claims no on-chain state.

## What is NOT demonstrated

- no live Midnight transaction
- no funded wallet
- no external LLM or model provider
- no production agent credential system (operator-scoped dev token;
  see SDK README limitation)

## Security

- Token handling: bearer token lives in the SDK client memory only;
  never printed, never written to files, never in exception text.
- NEVER-send data: private keys, wallet seeds/secrets, ZK witnesses,
  blinding values, signing secrets, raw credentials, other sessions'
  tokens, full user secrets. Demo payloads are synthetic and harmless.
- SDK is the integration boundary: the demo makes no raw HTTP calls,
  touches no database, and calls no engine/attestor internals.

## Troubleshooting

- `demo failed: UNAUTHORIZED: ...` — API down or wrong
  `BOND_DEV_AUTH_TOKEN`; verify step 3–4.
- `demo failed: NETWORK_ERROR: ...` — API not listening on
  `BOND_API_URL`.
- Database errors — ensure Postgres is up and migrations applied.
- Reruns are safe: registration reuses the existing agent; each run
  submits fresh activities (new UUIDs) producing new analyses.

## AI agent demo (`ai_agent_demo.py`)

An external AI-powered agent operating under BOND. BOND is not the
model: a provider-neutral `ModelProvider` interface (`generate(prompt,
context) -> ModelResponse`) supplies actions, and every model output
passes through SDK `build_activity()` validation before submission.

- **Scripted mode (default):** `BOND_DEMO_MODE=scripted` (or unset).
  `ScriptedModelProvider` needs no key, no internet, no wallet.
  Scenarios via `BOND_DEMO_SCENARIO=benign|risky`:
  - benign: allowlisted `pay-vendor` under the spend limit → zero
    findings expected ("No confirmed findings were returned").
  - risky: denylisted `self-transfer` at 3x the spend limit →
    `policy-denylist` (high/90) + `spend-limit-breach` (high/85)
    plus the `undeclared-action` guard (high) firing on the
    off-allowlist action — then attestation (2 demo attestors,
    threshold 2) → quorum → `partial-slash` decision → enforcement
    (SIMULATED) → release to WITHDRAWABLE where the state machine
    permits.
- **Live-model mode:** `BOND_DEMO_MODE=live-model` requires
  `BOND_MODEL_PROVIDER` + `BOND_MODEL_API_KEY`, then refuses clearly:
  no provider request/response format is verified in this
  environment, so execution would be fabrication.
- **Attestors:** deterministic per-run identities
  (`ai-demo-attestor-{1,2}-<run>`), fresh 32-char secrets per run;
  secrets travel only in the verdict header, never in output.
- **Reruns:** agent/bond/attestor handles recovered or recreated as
  the state machine permits; steps that cannot proceed (e.g. no live
  bond after a prior withdraw) report `skipped`/`BLOCKED` with reasons
  instead of failing or fabricating.
- **SIMULATED boundary:** enforcement output is always labeled
  `SIMULATED`; transaction references are adapter receipts, never
  blockchain confirmations. No live Midnight claims anywhere.

```bash
export BOND_API_URL=http://localhost:4000
export BOND_DEV_AUTH_TOKEN=dev-change-me
BOND_DEMO_SCENARIO=benign python sdks/demo/ai_agent_demo.py
BOND_DEMO_SCENARIO=risky python sdks/demo/ai_agent_demo.py
```
