# Phase 27 — Production Launch Hardening

Makes BOND production-launch ready without redesigning anything.
Code changes are limited to: the API image workspace list, CI
coverage, compose posture, and regression tests. Everything else
was verified ready as-built.

## 1. Production architecture

Single API container + Postgres 16 + optional worker (in-process)

- static web bundle, composed via `docker-compose.yml`. The API
  is stateless across replicas except process-local rate-limit
  buckets (documented limitation below). Migrations run manually
  (`db:migrate`, advisory-locked for concurrent operators) —
  never auto-applied at boot, so deploys cannot migrate
  unexpectedly. Chain work stays SIMULATED unless REAL is
  explicitly configured with a contract address.

## 2. Required environment variables

`DATABASE_URL` (always), `NODE_ENV=production`,
`CORS_ORIGINS` (explicit, no `*`), `MIDNIGHT_NETWORK`
(explicit; empty fails startup), `BOND_CONTRACT_ADDRESS`
(when the network is REAL — startup fails without it).
`DEV_AUTH_TOKEN` is forbidden in production (startup fails).
All other tuning has safe bounded defaults validated at boot
(ports, body limit ≤5mb, timeouts, pool sizing, worker knobs,
rate-limit budgets). Anything invalid fails fast with a named
error before serving traffic.

## 3. Startup sequence

`loadConfig()` (throws on any violation) → middleware →
routes → executors/finalizers registered → worker starts from
env → listen. `/health` proves liveness; `/ready` proves
database+schema and reports Midnight mode honestly
(SIMULATED is reported as-is, never as a live network).

## 4. Database migration procedure

Run `npm run db:migrate --workspace=apps/api` (or the equivalent
against the image's bundled `database/`) before starting new
code. Advisory transaction lock serializes concurrent
migrators; each file runs in its own transaction; failures roll
back that file only. Verify with `SELECT * FROM
schema_migrations`. No down migrations by design.

## 5. Worker startup

In-process via `startWorkerFromEnv()` (or `WORKER_ENABLED=false`
for API-only replicas). Leased claims, bounded retries with
backoff, dead letters with reasons, graceful drain on SIGTERM.
REAL handles resolve read-only; submission stays
wallet-attended by design.

## 6. Health checks

Compose: Postgres `pg_isready` gate → API depends on healthy DB;
API exposes `/health` (compose healthcheck, 30s interval).
`/ready` returns 200/503 with structured checks; `ready: false`
means stop routing traffic here.

## 7. Observability

Structured logs (request/agent/risk/attestation/transaction
ids, operation, error code — never secrets), `/metrics`
(server-defined labels only), worker snapshots via `/ready`,
protocol events for every lifecycle transition. Full request →
job → risk → attestation → chain → confirm → reconcile chains
are correlatable by request/transaction ids.

## 8. Security controls

Operator/agent/attestor auth with ownership checks on every
scoped route; public verification is read-only, privacy-shaped,
and rate-limited (global IP baseline + dedicated public
budgets); per-route budgets for auth/mutation/expensive paths;
100kb–5mb bounded bodies; request timeouts; helmet headers;
explicit CORS allowlist; sanitized error envelopes; no secrets
in env examples, logs, events, or images.

## 9. Rollback procedure

Stateless API: redeploy the previous image tag and restart.
Migrations are forward-only — rolling back code past a
migration is unsupported; restore from the pre-migration
database backup instead (see runbook §13–14). Chain state, once
finalized, cannot roll back; reconcile heals mirrors forward.

## 10. Recovery procedure

Database restore is manual, deliberate, and non-destructive by
default (runbook §13). Dead-lettered worker jobs carry reasons
and are retried manually after fixing the cause. Midnight
outage: `/ready` contract reports `unreachable`; rows stay
pending; sweeps resume automatically (runbook §11).

## 11. Midnight operational requirements

REAL mode needs an explicit network (`undeployed`/`preprod`;
`preview`/`mainnet` rejected), a deployed contract address, a
funded operator wallet (browser-held, never backend-held), and
reachable indexer/node/proof-server. See the Phase 25 ceremony
runbook. SIMULATED stays available for development.

## 12. Known external blockers

Preprod wallet funding and a deployed contract address
(Phase 25). Without them, REAL execution paths correctly
refuse — that is the safe state, not a defect.

## 13. Production launch checklist

- [ ] `DATABASE_URL`, `NODE_ENV=production`, `CORS_ORIGINS`,
      `MIDNIGHT_NETWORK` (+ `BOND_CONTRACT_ADDRESS` if REAL) set
- [ ] No `DEV_AUTH_TOKEN` in production env
- [ ] Migrations applied and verified in `schema_migrations`
- [ ] `/health` 200, `/ready` true (or 503 understood)
- [ ] Worker RUNNING (or deliberately disabled)
- [ ] Web image built with the production `VITE_API_URL`
- [ ] CORS origins match the served frontend
- [ ] Backups scheduled and restore-tested
- [ ] Rate-limit budgets reviewed for expected traffic

## 14. What changed in Phase 27

- `apps/api/Dockerfile`: links + builds `@bond/policy-engine`
  (previously missing → production boot crash while dev worked)
  and installs reproducibly via `npm ci`.
- `.github/workflows/ci.yml`: Postgres service, Python
  SDK/demo tests, API image build — CI now exercises what it
  claims to validate.
- `docker-compose.yml`: `CORS_ORIGIN` overridable, API
  healthcheck added.
- `apps/api/src/test-helpers.ts`: `TEST_PG_{USER,PASSWORD,HOST,PORT}`
  overrides (local defaults unchanged).
- Regression tests: `production-docker.test.ts` (workspace
  coverage, build order, reproducibility, compose posture).
- Reverted a miswired per-route public rate limit: the global
  layer already enforces the public budgets (sharing one store
  would double-charge); verified empirically, documented here.

## 15. CODE READY vs EXTERNAL INFRASTRUCTURE READY

CODE READY: configuration safety, API reliability, shutdown,
pooling, migrations, worker, auth, abuse protection, headers,
observability, images, compose, frontend build, docs.
EXTERNAL INFRASTRUCTURE READY: pending Preprod wallet funding
and contract deployment (Phase 25 blockers, unchanged).
