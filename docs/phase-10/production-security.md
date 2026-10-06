# Phase 10 — Production Security

Security hardening pass over the BOND application. No architecture changes:
the Agent Platform → SDK/Adapter → API → Registry → Risk Engine → RiskFlag →
Attestor → Midnight Adapter → Compact Contract pipeline is untouched, the
Risk Engine still cannot touch transactions, SIMULATED stays SIMULATED, and
the Midnight Adapter remains the sole chain seam.

## Security architecture

- Operator sessions: random tokens, SHA-256 hash storage only, 24h expiry,
  revocation list, timing-safe dev-key check, production fail-closed
  (`DEV_AUTH_TOKEN` forbidden with `NODE_ENV=production`).
- Authorization: `requireAuth` → `requireOperator`, ownership resolved
  server-side from the session principal through
  `services/authorization.ts` (transitive for transactions:
  agent → bond; orphans denied). `operatorId` is never taken from bodies.
- Attestors: separate credential (`X-Attestor-Secret`, hashed compare,
  active-status required); attestor secrets never touch operator endpoints.
- Defense in depth: Helmet, explicit CORS allowlist, bounded JSON bodies,
  request timeouts, global + per-route rate limits, idempotency with
  fingerprint conflicts (409), state machines per domain.

## Threat model

| Threat                              | Surface                        | Existing defense                      | Gap found                        | Disposition                |
| ----------------------------------- | ------------------------------ | ------------------------------------- | -------------------------------- | -------------------------- |
| A. Unauthenticated attacker         | all routes                     | `requireAuth`, 401 envelope           | none                             | —                          |
| B. Malicious authenticated operator | others' resources              | ownership helpers                     | tx-create had NO ownership check | FIXED                      |
| C. Operator vs own agent            | own rows                       | operator binding                      | none                             | —                          |
| D. Cross-operator access            | `:id` routes                   | `require*Ownership`                   | tx-create, attestor squat        | FIXED                      |
| E./F. (Compromised) attestor        | verdicts                       | secret + active check                 | assignment list advisory-only    | ACCEPTED RISK (documented) |
| G. Malicious platform               | activity/evidence              | domain validators                     | capabilities elements unchecked  | FIXED                      |
| H. Replay                           | idempotency/nullifiers/consume | 409 + CONSUMED guard                  | oversized keys → 500             | FIXED (400)                |
| I. Tampering                        | bodies/query/params            | validators                            | `?limit` NaN/negative → 500      | FIXED (400)                |
| J. DB compromise                    | —                              | parameterized SQL, hash-only secrets  | none                             | —                          |
| K. Compromised instance             | env/secrets                    | fail-closed config, no secret logging | none                             | —                          |
| L. Public client                    | verification                   | scoped projections, rate limits       | verified clean                   | —                          |
| M. Malicious evidence               | risk/eligibility inputs        | adapter validators                    | verified clean                   | —                          |

## Findings

### FIXED (this phase)

1. **HIGH — BOLA on transaction creation.** `POST /api/v1/transactions`
   stored arbitrary `agentId`/`bondId` without ownership verification, so any
   operator could plant intents (including `ENFORCEMENT`) linked to another
   operator's agent/bond. Fixed in `createTransactionIntent`
   (`services/transactions.ts`): referenced agent/bond must exist (404) and
   belong to the caller (403). The enforcement route already passes owned
   resources, so legitimate flows are unaffected.
2. **HIGH — Attestor credential takeover via re-registration.**
   `POST /api/v1/attestors` upserted any caller-supplied `attestorId`,
   overwriting its secret — any operator could impersonate/reset another
   attestor's credential. Registration is now create-only
   (`services/attestations.ts`): existing ids fail closed (400), and
   caller-supplied ids are shape-checked with `parseAttestorId`.
3. **MEDIUM — `GET /agents?limit` unvalidated.** `NaN`, negatives, and
   fractions reached PostgreSQL as `LIMIT` (500). Now strict integer 1–100
   (400 otherwise) in `routes/agents.ts`.
4. **MEDIUM — `capabilities[]` elements unvalidated.** Non-strings and
   unbounded strings reached `JSON.stringify`/storage. Now: ≤100 entries,
   each a non-empty string ≤256 chars (`services/agents.ts`).
5. **LOW — Idempotency-key shape.** Oversized keys surfaced as DB errors
   (500). Central check in `runIdempotent`: 1–256 chars (400 otherwise).
6. **LOW — Malformed ids returned 404 instead of 400.** Strict branded
   parsing added at ownership boundaries: bonds, transactions,
   `requireAgent/Bond/Flag/AttestationOwnership`, and `GET /risk/flags/:id`.
   Well-formed unknown ids still return 404; no 404→403 oracle was
   introduced (ownership checked after existence, as before).

### ACCEPTED RISK

- **Attestor assignment is advisory.** `attestorIds` on attestation requests
  are not persisted and quorum counts distinct verdicts from any _active_
  attestor. Any active attestor may therefore verdict any attestation. This
  matches the independent-attestor model (no operator binding exists
  without a schema change), and quorum still requires `threshold` distinct
  live credentials. Persisting assignments is FUTURE HARDENING.
- **`POST /auth/sign-out` has no dedicated rate budget.** Authenticated,
  cheap, session-scoped; not a flood vector. No change.
- **Dev-only interim auth.** Pre-shared dev key; production fails closed.
  Real wallet auth is Phase 11.

### PHASE 11 DEPENDENCY

- Wallet authentication, Lace integration, real Midnight network/session
  shape. Nothing in this phase invents a temporary production auth
  mechanism.

### FUTURE HARDENING

- Persist attestation→attestor assignments and enforce verdict eligibility.
- Attestor secret rotation API (create-only registration has no rotation
  path by design).
- Shared rate-limit store for multi-replica deployments (Phase 9.5 note).

## Audit summaries

- **Authorization/BOLA:** every `:id` route audited; all reads/mutations
  resolve ownership server-side. `operatorId`/`ownerId` never sourced from
  request bodies. Attestor endpoints correctly isolated from operator
  sessions (both directions tested).
- **Input validation:** bodies, query, params, enums, amounts (digit
  strings, `BigInt > 0`), timestamps (ISO, domain-checked), state
  transitions (Phase 1 machines) verified; gaps fixed (§FIXED 3–6).
- **Database/injection:** all values via `$N` bindings; `ORDER BY`/columns
  static; `LIMIT` bound; no `OFFSET`; no user input in migrations. No
  command/shell/template sinks exist (no `exec`, no server HTML rendering).
  SQL-shaped input proven inert by test.
- **SSRF/path:** no user-controlled outbound fetch exists; Midnight
  endpoint URLs are deployer-controlled env (operator trust boundary);
  no request-influenced filesystem paths (migrations use fixed dirs).
- **Deserialization:** no deep merges of untrusted objects; no
  `__proto__` vector; `localStorage` JSON guarded + text-rendered.
- **Error/logging/secrets:** safe envelope (`code/message/requestId`) on
  all paths; no stacks/SQL/paths/secrets; structured allowlist logs; no
  committed secrets (`.env` ignored, only placeholders tracked); no
  secret printing in code, tests, or compose.
- **CORS/headers:** explicit allowlist (no `*`), Helmet, body caps,
  timeouts, JSON 404s — unchanged and suite-covered.
- **Auth/session:** verified secure tokens, hashed storage, expiry,
  revocation, sign-out scoping (new test: only the caller's session dies),
  timing-safe comparisons, no fixation (fresh random token per issuance).
- **Rate limiting:** Phase 9.5 re-audited — no bypass (mutations return
  null globally and are covered per-route post-auth; spoofed
  `X-Forwarded-For` ignored unless trusted); store bounded; 429s carry
  request ids and no key material.
- **Replay/idempotency:** same-key/same-payload replays stored result;
  same-key/different-payload → 409; failed keys require fresh keys;
  eligibility double-consume → 409; attestation expiry/freshness enforced.
- **State machines:** agent/bond/transaction/attestation/eligibility/risk
  transitions go through existing domain machines; illegal jumps rejected.
- **Privacy:** public verification exposes no amounts, witnesses,
  nullifiers, secrets, or operator ids (asserted on the wire); "no
  confirmed violation" is never labeled safe.
- **Frontend:** no `dangerouslySetInnerHTML`/`innerHTML` sinks, no `eval`,
  no open redirects (hash router only), tokens in `localStorage` (standard
  SPA trade-off, no XSS sink present), errors as React text nodes (new
  adversarial rendering tests).
- **Dependencies:** `npm audit --omit=dev` → 0 vulnerabilities. Full audit
  shows 6 advisories, all dev-toolchain only (vitest/tinypool/vite/esbuild);
  fixes require breaking majors (vitest 5, vite 8) with no production
  exploit path — not actionable, no upgrades performed.

## Security tests added

- `apps/api/src/security-phase10.test.ts` — 22 tests (A–J in the file
  header): cross-operator tx create/advance/read, attestor squat + secret
  preservation, limit/capabilities/key validation matrices, replay vs
  conflict, strict-id 400s, SQL-shaped inertness, public privacy wire
  assertion, sign-out scoping, envelope leakage assertion.
- `apps/web/src/test/security-phase10.test.tsx` — 2 tests: markup- and
  script-shaped backend text renders inert (no elements created).

## Residual risks (honest)

BOND is not completely secure: dev-key auth until Phase 11, process-local
rate limits, advisory attestor assignment, `localStorage` bearer tokens,
and operator-trust of `MIDNIGHT_*_URL` env remain. See ACCEPTED RISK above.
