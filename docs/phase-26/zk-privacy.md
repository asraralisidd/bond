# Phase 26 — ZK & Privacy Hardening

Audit and regression locks for BOND's complete privacy boundary.
No architecture changes; no dependency upgrades; no behavior
changes except one public-endpoint scrub (below). All findings
were verified in-tree before acting; clean-by-design areas are
recorded as audited, not changed.

## 1. Privacy data-flow map

Notation per boundary: IN (what enters) → HELD (what persists) →
OUT (what leaves), each tagged PRIVATE or PUBLIC, plus the
enforcement mechanism.

### Smart contract (`contracts/bond.compact`)

- IN (private): `operatorSecret`, `commitmentAmount`,
  `commitmentSalt` witnesses — supplied per call, never stored.
- HELD PUBLIC (by Compact semantics, deliberate): status codes,
  slash counts, cumulative PUBLIC `slashedTotal` (enforcement
  transparency), nullifiers, commitments, policy hashes, purpose
  codes, counters. Amounts and secrets are never ledger fields —
  enforced by construction (no such struct fields exist).
- OUT: circuit return values are unit (`[]`); public reads expose
  bands/statuses/counts only (`toPublicContractLedgerView`,
  key-locked by test).
- Mechanism: type system + `boundary.test.ts` + projection shape
  test (`privacy-boundary.test.ts`).

### ZK eligibility

- IN (private): amount, salt, secret as per-call private state;
  never enter service types (no such fields exist).
- HELD: proof records (`proofId`, agent/bond bindings, policy,
  purpose, nullifiers, expiry, status) — no private values.
- OUT: allowlisted public views (`eligible` + reason codes only).
- Mechanism: `EligibilityProof` type has no private fields;
  `eligibility.test.ts` asserts witness-free creation.

### API DTOs

- Rule: DB rows never serialize directly. Owner views go through
  explicit private DTOs; public views exclusively through audited
  projections that cannot represent private fields.
- Verified: `commitment_minor_units` never leaves the server
  (absent from `BondPrivateView`); credential/grant/attestor
  list views carry metadata only (hashes stripped by
  `toMetadata`); transaction GET omits `last_error`/params;
  error bodies are exactly `{code, message, requestId}`
  (DomainError `details`, which carry raw values, never
  serialize — locked by test).

### Logging

- Allowlisted structured records only
  (`requestId/agentId/riskFlagId/attestationId/transactionId`,
  operation, errorCode, message). No parameter slot exists for
  private values; no call site interpolates secrets/amounts
  (verified by search). Pool errors log truncated messages
  without connection strings; request bodies/headers are never
  logged; rate-limit denials log operation names only.

### Database

- Secrets persist as hashes only (sessions, agent/attestor
  credentials, setup grants). Commitments persist as principals
  (owner-private, never returned). Slash amounts and nullifiers
  persist as public enforcement records (intended). Activity
  ledger holds action/tool/amount/usage features only — never
  text, metadata, or secrets. No private blockchain state is
  stored anywhere (witnesses live per-call in memory).

### Frontend

- Browser storage allowlist: session token, operator id, wallet
  verifying key + network, expiry flag, recent-item ids
  (source-scan locked). No attestor secrets, witnesses, keys, or
  raw activity in storage, URLs, or console output. Attestor
  secrets are request-scoped only. Recent-item labels carry
  ids/statuses only.

### Midnight adapter

- REAL/SIMULATED separation enforced by handle mode; read-only
  bundles refuse signing/submission by construction. Adapter
  errors sanitize to codes (`toMidnightError` keeps constructor
  names only). No backend component receives wallet private
  keys — the wallet signs internally; only public signature
  material crosses.

### Wallet boundary

- Sessions bind to the signing verifying key only; address↔key
  ownership is unproven and unclaimed. No custodial wallet
  exists; none may be added without a dedicated safety review.

## 2. Change made in Phase 26

**F1 — `/ready` worker `lastError` scrubbing** (`system.ts`).
`stats.lastError` derives from raw error text
(`safeFailureMessage`) and `/ready` is unauthenticated, which
contradicted the route's documented "no credentials" contract.
Full text stays in logs/DB for operator diagnostics; the public
projection now redacts credential assignments, bearer tokens,
PEM blocks, URL passwords, and mnemonic/seed material
(conservatively: any mention redacts). Caught and refined by
its own tests (including a real multi-word-secret gap found
during development).

## 3. Regression locks added

- `privacy-boundary.test.ts` (7): error-body exact shape on
  live 400/401/404 paths; canary-laden `DomainError.details`
  never serialize; unknown errors generic; MidnightError safe
  mapping; sanitizer unit matrix; public ledger view key lock.
- `storage.test.tsx` (2): browser storage key allowlist with
  constant resolution; console/custodial-material source scan.

## 4. Audited clean (no change)

Contract ledgers/circuits, ZK eligibility types, all response
DTOs, event payloads (ids/statuses/codes), idempotent snapshots
(no secret-bearing responses use idempotency), error message
texts (field names, never values), worker/dead-letter handling
(DB-only, unexposed), metrics labels, request logging
(absent), frontend views/storage/labels, SDK error surfaces,
demo output (canary-asserted), docs (no real secrets), tracked
files (no secrets).

## 5. Disclosure policy

Disclose by default-deny: a field reaches a public surface only
through an explicit allowlisted projection reviewed for that
purpose. Private-by-default categories: bond principals,
witnesses/salts/secrets, raw credentials, raw activity content,
wallet private state, provider credentials. Public-by-design:
statuses, bands, counts, cumulative slash totals, nullifiers,
commitments, policy hashes, protocol ids/timestamps.

## 6. Remaining risks

- Sanitizer patterns are syntactic: a novel secret encoding
  (e.g., split across log fields) would pass. Mitigation:
  logs accept no free-form private slots by construction; the
  scrubber is defense-in-depth, not the primary control.
- `last_error`/`dead_letter` DB columns retain raw messages for
  operators — appropriate (access-controlled diagnostics), but
  DB backups inherit that sensitivity.
- Session bearer tokens live in browser localStorage (standard
  SPA practice, documented); XSS remains the residual vector —
  unchanged by this phase, noted for production review.
- Real Midnight execution (Phase 25 blockers) would introduce
  live chain error text; the scrubber and read-only provider
  design already cover that path, but ceremony-time review
  should re-run the secret scans.
