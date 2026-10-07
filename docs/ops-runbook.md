# BOND Operations Runbook

Operational guide for running BOND. For Midnight deployment specifics
see `docs/phase-14/devnet-readiness.md`; nothing here claims live-chain
execution.

Core invariants (never violate during operations):

- **CHAIN WINS OVER LOCAL MIRROR.** Reconciliation heals the database
  from chain state, never the reverse.
- No fake finality: `CONFIRMED` requires authoritative finality.
- No REAL → SIMULATED fallback, anywhere.
- Backend is non-custodial: no private keys, seeds, or signing secrets
  exist server-side, in env files, backups, or logs.
- Risk Engine path is Risk Engine → RiskFlag → Attestor → Enforcement.
  The Risk Engine cannot sign blockchain transactions.
- Public verification stays privacy-safe.

## 1. Local startup

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev:api   # :4000
npm run dev:web   # :5173
```

Dev defaults: `VITE_API_URL=http://localhost:4000`, SIMULATED Midnight,
dev-key auth (`DEV_AUTH_TOKEN`).

## 2. Production startup

```bash
docker compose up --build -d
```

Production requires: `NODE_ENV=production` (compose sets it),
explicit `CORS_ORIGINS`, explicit `MIDNIGHT_NETWORK`, no
`DEV_AUTH_TOKEN`, and `BOND_CONTRACT_ADDRESS` when the network is REAL.
The API fails fast at startup otherwise — by design.

## 3. Environment configuration

See `.env.example`. Midnight vars (`MIDNIGHT_NETWORK`,
`MIDNIGHT_INDEXER_HTTP/_WS`, `MIDNIGHT_NODE_URL`, `PROOF_SERVER_URL`,
`BOND_CONTRACT_ADDRESS`, `BOND_ZK_ASSETS_PATH`) pass through compose
with empty SIMULATED-preserving defaults; set them explicitly per
environment. Wallet keys/secrets NEVER go in env files.

## 4. Database migration

Migrations are forward-only (`database/migrations/`, advisory-locked
so concurrent instances are safe). Apply manually before deploying:

```bash
npm run db:migrate
```

There are no down migrations. Never edit an applied migration; add a
new one.

## 5. /health

Liveness only: `{ status: "ok", version, service: "bond-api" }`.
Proves the process is alive, nothing else.

## 6. /ready

Readiness: database connectivity + schema presence + worker snapshot +
Midnight mode/network/contract status. `ready: false` (HTTP 503) means
do not route traffic here. Contract status is one of
`not-applicable` / `address-missing` / `unreachable` / `reachable` /
`misconfigured` — informational only, never affects `ready`.

## 7. /metrics

Prometheus text (`text/plain; version=0.0.4`), rate-limit-exempt like
`/health`. Families: `bond_http_requests_total{method,route,status_class}`,
`bond_http_request_duration_seconds_*` (fixed buckets), `bond_worker_*`
(polls, claimed, submitted, confirmed, retried, dead-lettered,
reconciled, stuck, active, running, phase), `bond_process_*` (uptime,
RSS). Labels are bounded server-defined templates; unknown paths
collapse to `unmatched`. No tokens, secrets, URLs, amounts, or error
text appear. Scrape interval 15–30s is plenty.

## 8. Worker

Background job runtime (poll → claim → execute → persist). Observe via
`/metrics` (`bond_worker_*`) and `/ready` snapshot. `stuckSubmitted >
0` sustained means reconciliation needs attention (see §10).
`dead_lettered` increments only on terminal failure after bounded
retries. The worker never submits REAL transactions blindly and never
holds keys.

## 9. Transaction processing

`IDLE → WALLET_APPROVAL → PENDING → SUBMITTED → CONFIRMED/FAILED`.
Operator advance covers the first three transitions; wallet relay
records `SUBMITTED` with a chain reference (`POST /:id/submitted`);
only finality observation moves rows to `CONFIRMED`. Conflicting chain
references return 409 — investigate before retrying with a new key.

## 10. Reconciliation

`reconcileTransactionRows` resolves `SUBMITTED` rows against
`watchForTxData` finality: `SucceedEntirely` → `CONFIRMED` + mirrors
(exactly once), anything else observed → `FAILED`, unreachable →
untouched for the next pass. `reconciliation_required` rows without a
chain reference await wallet submission; they are not errors. Chain
state always wins local disagreements.

## 11. Midnight outage/unavailability

Symptoms: `/ready` contract `unreachable`, worker `reconcile` errors,
confirm calls 502 `MIDNIGHT_UNAVAILABLE`. Response: API keeps serving
off-chain reads/writes; intents queue as PENDING/SUBMITTED; nothing is
marked CONFIRMED/FAILED without evidence; recovery is automatic on
reconnect (sweeps resume). Never switch the deployment to SIMULATED to
"recover" — that would mislabel test traffic as chain activity.

## 12. Backup

```bash
DATABASE_URL=postgresql://... node scripts/backup.mjs [--dir ./backups]
```

Produces `bond-db-YYYYMMDD-HHMMSS.dump` (`pg_dump --format=custom
--no-owner --no-privileges`). Connection travels via libpq env vars;
the URL never appears on argv, in logs, or in error output. Verify the
file exists and is non-empty afterwards. Schedule via cron/systemd —
automation lives outside this repo by design.

## 13. Restore (manual, deliberate, non-destructive by default)

1. Create a scratch database (NEVER restore over production directly):
   `createdb bond_restore_test`.
2. `pg_restore --no-owner --dbname=bond_restore_test <file>`.
3. Validate: schema-migration count matches, spot-check row counts
   (`agents`, `bonds`, `chain_transactions`, `protocol_events`).
4. Only after validation, plan a maintenance window; stop writers;
   take a fresh production backup first; then restore to production.
5. Re-run migrations forward if the dump predates the code.

## 14. Rollback

Code rollback: redeploy the previous image/tag. Database has no down
migrations — forward-only. If a deploy introduced a bad migration,
write a compensating forward migration; never hand-edit applied
migrations. Worker state (leases/claims) reconciles itself on restart
via claim expiry.

## 15. Retention

- **Ephemeral (auto-cleaned):** `wallet_challenges` (expired+unconsumed
  purged on issuance), `idempotency_keys` (TTL reclaim/overwrite).
- **Sessions:** expired/revoked rows fail closed but are never deleted
  automatically (revocation checks need them until expiry). Growth is
  ~1 row/login; manual cleanup of long-expired rows is safe
  (`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`)
  because a missing row simply reads as unauthorized.
- **Audit/security history (NEVER auto-delete):** `protocol_events`,
  `attestations`, `slash_events`, `reputation_records`,
  `chain_transactions`. No automated retention exists for these by
  design — deleting them would destroy auditability, reconciliation
  evidence, and enforcement history.

## 16. Incident response

1. Check `/health` (process), `/ready` (deps), `/metrics` (rates/errors).
2. Correlate via `x-request-id` across logs (structured pino records
   carry request/agent/tx/attestation IDs only — never secrets).
3. DB failure → 503s; worker keeps retrying with backoff; no data loss
   (intents persist; claims expire).
4. Suspected compromise → rotate `DATABASE_URL` credentials, revoke
   sessions (`UPDATE sessions SET revoked = TRUE`), redeploy clean
   images; chain state remains authoritative for mirrors.

## 17. Common failures

| Symptom                                      | Likely cause                  | Action                            |
| -------------------------------------------- | ----------------------------- | --------------------------------- |
| Startup throw `MIDNIGHT_NETWORK … SIMULATED` | prod without explicit network | set `MIDNIGHT_NETWORK`            |
| Startup throw `BOND_CONTRACT_ADDRESS … REAL` | REAL without address          | set address or use `simulated`    |
| Startup throw `DEV_AUTH_TOKEN … production`  | dev key in prod env           | unset it; use wallet auth         |
| `address-missing` on `/ready`                | REAL, no address yet          | expected pre-deployment           |
| `unreachable` on `/ready`                    | indexer down / wrong address  | check network + address           |
| `stuckSubmitted` growing                     | finality not observed         | check Midnight availability (§11) |
| 409 on `/submitted`                          | conflicting chain ref         | investigate, new key if genuine   |
| 429s                                         | rate limits                   | back off; check `Retry-After`     |

## 18. REAL vs SIMULATED behavior

SIMULATED (default, labeled): in-memory normative rules, `sim-` tx ids,
operator-confirmed. NEVER presented as chain activity. REAL: wallet +
endpoints + contract address required; submission via wallet relay;
confirmation via finality only. `mainnet`/`preview` are rejected without
verified presets. No path converts one to the other.

## 19–21. Funded-wallet / contract / proof-server requirements

All **BLOCKED / NOT VERIFIED**: no funded wallet, no deployed contract,
no verified proving path in this environment. See
`docs/phase-14/devnet-readiness.md` for the exact procedure once
infrastructure exists. Do not improvise these steps.

## 22. Remaining external blockers

Funded Lace-compatible wallet; deployed BOND contract; reachable
indexer/node/proof-server with a working proving path; `preview` /
`mainnet` endpoint verification.
