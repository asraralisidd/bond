# BOND Phase 7 — Backend + PostgreSQL

> The backend is the application orchestration boundary: versioned APIs,
> PostgreSQL persistence, and the ONLY runtime caller of the Midnight
> Adapter. Risk and Attestor run as pure functions; the chain decides
> finality; the database never pretends otherwise.

## 1. Authority model (the core contract of this phase)

| Class                   | Owner                   | Examples                                                                                                      |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| CHAIN-AUTHORITATIVE     | Midnight contract       | bond/agent lifecycle effects, nullifier consumption, slash execution, tx finality, contract version           |
| OFF-CHAIN authoritative | Backend DB              | operator sessions, risk analyses/flags, attestation evaluations, evidence descriptors, idempotency, API audit |
| DERIVED                 | Recomputed from history | reputation snapshots, dashboard aggregates, public verification verdicts                                      |
| CACHE (mirror)          | DB rows tracking chain  | bond/agent status mirrors, pre-finality tx rows, eligibility mirrors                                          |

Rules: chain wins for chain-authoritative fields (reconciliation heals
mirrors and records `CHAIN_DIVERGENCE_DETECTED` — never silent
overwrites). `SUBMITTED` is never presented as `CONFIRMED`. SIMULATED
confirmation requires an explicit operator action (dev-only,
auditable). PostgreSQL nullifiers are a local dedupe aid; Midnight
consumption remains authoritative.

## 2. Modules (`apps/api/src`)

`config.ts` (fail-fast env), `observability.ts` (pino + allowlisted
`buildLogRecord`), `db/pool.ts` (single pool, parameterized helpers),
`db/migrate.ts` (up-only SQL runner + `schema_migrations` table),
`db/stores/{operators,registry,risk,attestation,chain,events}.ts`
(SQL per aggregate, branded IDs validated at service boundary),
`http/{auth,errors,request-id,dto}` + `http/routes/*` (thin),
`services/{agents,bonds,risk,attestations,eligibility,transactions,
executors,reconcile,events,idempotency}.ts` (orchestration).
Risk/Attestor are imported as pure functions only — no sockets, DB
handles, or wallets cross into them.

## 3. Database

Seven migration files (`database/migrations/001–007`): operators +
sessions (token hashes only), agents + bonds (duplicate-triple
UNIQUE, one-live-bond partial index), evidence + risk, attestors +
attestations + slashes + reputation, chain aux (eligibility,
nullifiers, transactions, idempotency, append-only `protocol_events`
via trigger, sync checkpoints), tx params, attestor credentials
(hashed). Amounts are TEXT digit strings; timestamps TIMESTAMPTZ;
arrays/objects JSONB. New event types beyond Phase 1 (all meaningful):
`AGENT_STATUS_CHANGED`, `BOND_STATUS_CHANGED`, `BOND_CREATED` (was
conceptual), `ATTESTATION_RECORDED`, `DECISION_ISSUED`,
`ELIGIBILITY_PROVED/CONSUMED`, `CHAIN_DIVERGENCE_DETECTED`.

## 4. API (`/api/v1`)

Auth: `POST /auth/session` (dev key → session), agents CRUD +
`PATCH :id/status` (transition-machine enforced), bonds CRUD +
`PATCH :id/status`, transactions (create idempotent, get, advance,
explicit confirm), risk analyses + flag reads, attestors register,
attestations (request, verdicts via `X-Attestor-Secret`, evaluate,
decision, enforce), eligibility proofs (create/verify/consume),
public verification (no auth). Every mutating route accepts
`Idempotency-Key`; every response carries `x-request-id`.

## 5. Auth model (interim, explicit)

Pre-shared `DEV_AUTH_TOKEN` → opaque sessions (SHA-256 hashed,
24h expiry, revocation). Wallet-signature login is BLOCKED (Phase 5
Lace shape unresolved); `operators.wallet_address` reserved nullable.
Attestors use per-attestor secrets (hashed) via `X-Attestor-Secret` —
real credential separation, no wallet invented, no hardcoded prod
credentials (dev seed only, documented).

## 6. Privacy enforcement

DTOs only (rows never serialized); public views reuse the audited
Phase 1/4/6 projection functions; evidence rows hold hashes/pointers;
errors map to safe codes (no stacks/SQL/secrets); logs allowlisted via
`buildLogRecord` (shape asserted in tests); trigger-enforced
append-only audit. Leakage suites cover public/private endpoints,
errors, and logs with canary values.

## 7. Transaction lifecycle + worker

Phase 1 machine enforced on every advance. Intents bind 1:1 to
idempotency keys. Worker (`runTransactionWorkerOnce`) advances PENDING
via registered purpose executors (SIMULATED adapter ops seeded from DB
state through public reads); REAL handles without wallets are skipped,
never faked. Purpose finalizers run on CONFIRMED (bond/agent mirrors,
slash records, reputation refresh). Reconciliation (`runReconciliationOnce`)
compares chain-known states, heals chain-wins, records divergence,
advances `sync_checkpoints`.

## 8. Verification

27 API tests (auth, registry, bonds, idempotency incl. concurrency,
tx lifecycle incl. no-auto-confirm, risk, attestation→decision→
enforcement→slash end-to-end, eligibility lifecycle, public
verification + leakage, reconciliation healing, migration/trigger/
nullifier/error-map/log-shape hardening) + all Phase 0–6 suites green.
New Phase 7 event types are additive; no Phase 0–6 semantics changed.

## 9. Remaining blockers / next step

Wallet-signature auth, live devnet + funded wallet (REAL paths are
coded, unexecuted), fee behavior, attestor key ceremony. Recommended
next step (Phase 8): React dashboard consuming these endpoints,
starting with read-only screens (agents, bonds, flags, public verify)
against SIMULATED backend.
