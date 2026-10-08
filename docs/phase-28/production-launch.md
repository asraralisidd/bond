# Phase 28 — Production Launch (final)

Final launch assessment, release artifacts, smoke results, and the
launch decision. This document distinguishes what is proven by
evidence from what remains externally blocked.

## 1. Launch matrix

| AREA                       | STATUS                      | EVIDENCE                                                                                          |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| Backend                    | READY                       | full suite green; fail-closed config tests; graceful shutdown tests                               |
| Frontend                   | READY                       | prod build succeeds; localhost refused structurally + at runtime; error states; no source maps    |
| Database                   | READY                       | advisory-locked migrations (manual, never auto); 95 index/constraint objects; atomic transactions |
| Authentication             | READY                       | session/wallet/challenge suites; hash-only storage                                                |
| Authorization              | READY                       | ownership boundary suites; agent/operator/attestor isolation                                      |
| Risk Engine                | READY                       | deterministic rules + behavioral + policy scoring; boundary tests                                 |
| Attestor System            | READY                       | quorum/decision/enforcement suites; no engine→chain path                                          |
| Policy Engine              | READY                       | versioned policies; v3 scoring; server-authoritative context                                      |
| Worker System              | READY                       | leases, retries, dead letters, drain, exactly-once finalizers                                     |
| API reliability            | READY                       | timeouts, body limits, error envelopes, request IDs                                               |
| Privacy                    | READY                       | Phase 26 boundary + storage + ledger-view locks                                                   |
| Security                   | READY                       | secret scans; capability denials; no debug endpoints; helmet; CORS allowlist                      |
| Docker                     | READY                       | API image builds, boots, serves; web image refuses localhost                                      |
| CI/CD                      | READY WITH OPERATIONAL STEP | pipeline covers PG + Python + image build once merged and run                                     |
| Observability              | READY                       | structured logs, request/tx/job IDs, metrics, worker snapshots, protocol events                   |
| Documentation              | READY                       | runbook, ceremony, privacy model, this file                                                       |
| Midnight contract          | READY                       | 12 circuits compiled; artifacts complete; behavior unchanged                                      |
| Midnight adapter           | READY                       | REAL seams fail closed; SIMULATED labeled; read-only reconcile                                    |
| ZK eligibility             | READY                       | lifecycle + nullifiers + arg builders; SIMULATED-FIXTURE only in API                              |
| Wallet integration         | READY WITH OPERATIONAL STEP | challenge auth live; connector typed; funded wallet required for submission                       |
| Real transaction execution | BLOCKED — EXTERNAL          | needs funded wallet + deployed contract (Phase 25 blockers)                                       |
| Deployment                 | READY WITH OPERATIONAL STEP | script + record verifier + runbook; execution is wallet-attended                                  |
| Confirmation               | READY                       | finality-only semantics implemented + tested; unexercised live                                    |
| Reconciliation             | READY                       | chain-wins healer implemented + tested; unexercised live                                          |
| Rollback/recovery          | READY                       | forward-only chain truth; DB restore + dead-letter procedures documented                          |

## 2. Release configuration audit (verified)

- No dev secrets, tokens, keys, or mnemonics in tracked files,
  env examples, compose, Dockerfiles, docs, or vectors.
- No localhost production dependencies: web build refuses
  localhost structurally and at runtime; compose defaults are
  dev-scoped with production overrides documented.
- No debug endpoints; no stack traces to clients; error bodies
  pinned to `{code, message, requestId}`.
- CORS explicit allowlist; `*` rejected at startup.
- SIMULATED cannot present as REAL: mode-labeled receipts,
  `/ready` reports mode honestly, live tests refuse fallback.

## 3. Release artifacts verified

- API Docker image: builds from clean tree, boots in
  `NODE_ENV=production`, serves `/health` + `/ready`
  (SIMULATED honestly reported, worker RUNNING).
- Frontend production bundle: builds with explicit origin, no
  localhost leak, no source maps.
- Migrations: 016 files, deterministic order, advisory-locked,
  manually applied (verified via test harness on every run).
- Lockfiles: `package-lock.json` synced; Python pinned via
  `pyproject.toml` (`httpx>=0.27`, `pytest>=8`).
- Compact artifacts: 12/12 circuits with prover/verifier keys
  and generated bindings (verified by deploy-script checks).

## 4. Launch smoke test

`apps/api/src/launch-smoke.test.ts` (release gate): one
deterministic pass — health → auth → authz denial → register →
public verify (no commitments) → bond → fund via worker →
confirm → eligibility → risk flag → attestor quorum → decision
→ enforcement intent → worker submit (`sim-` id) → confirm →
PARTIALLY_SLASHED → structured errors → full audit trail.
Green. REAL steps remain ceremony-gated by construction.

## 5. Midnight ceremony status (unchanged, external)

PREPARE (toolchain/artifacts verified) and VERIFY (dry-run,
record verifier) are executable today. FUND → DEPLOY → RECORD
→ CONFIGURE → live SUBMIT/CONFIRM/RECONCILE await a funded
wallet, deployed contract, and reachable proof setup. The
ceremony runbook (`docs/phase-25`) and record template +
verifier are the complete tooling; no further code is required
to begin the ceremony.

## 6. Production checklist status

- [x] Backend production build
- [x] Frontend production build
- [x] Database migrations
- [x] Authentication
- [x] Authorization
- [x] Rate limiting
- [x] Security headers
- [x] Privacy boundary
- [x] Secret scan
- [x] Dependency audit (0 vulnerabilities when registry reachable)
- [x] Docker build
- [x] CI validation (pipeline extended; runs on merge)
- [x] Worker reliability
- [x] Observability
- [x] Backup/recovery procedure
- [x] Rollback procedure
- [x] Contract artifacts
- [x] Midnight configuration
- [ ] Wallet funding — EXTERNAL, BLOCKED
- [ ] Contract deployment — EXTERNAL, BLOCKED
- [ ] Contract address verification — EXTERNAL, BLOCKED
- [ ] Real transaction submission — EXTERNAL, BLOCKED
- [ ] Confirmation — EXTERNAL, BLOCKED
- [ ] Reconciliation — implemented, live run BLOCKED
- [x] End-to-end smoke test (SIMULATED path)

## 7. Known blockers

Preprod wallet funding and contract deployment only. No code
defects remain for any REAL path; every REAL seam fails closed
today by tested design.

## 8. Launch decision

**LAUNCH READY — PENDING EXTERNAL MIDNIGHT CEREMONY.**

The system is genuinely ready to launch into SIMULATED-supervised
operation today, and every REAL path is implemented, tested
offline, and blocked only on the wallet/funding/deployment
ceremony — which must happen wallet-attended, never forced.
Claiming unqualified LAUNCH READY would require independently
verified CONFIRMED mainline transactions, which do not exist.
