# 10 — Versioned API concept (`/api/v1/*`)

> No endpoints are implemented in Phase 0. For each area: purpose,
> authentication, authorization, input/output shape concepts, idempotency.

General rules: all routes under `/api/v1`; auth via operator session tokens
(initial; wallet-signature auth is a later hardening step, doc 13);
every mutating route requires a client idempotency key and returns a
`requestId`; errors use a stable taxonomy (Phase 1 to define); list routes
paginate (cursor concept).

## 10.1 Areas

- **`/api/v1/agents` — registration & management.** Purpose: register, read,
  update metadata, suspend/resume. Auth: operator session. Authorization:
  owner-only writes; reads owner-scoped except via public surface (doc 12).
  Input: platform label, type, capabilities, external ref + idempotency key.
  Output: `agentId`, derived statuses. Idempotency: re-register with same
  triple rejected as duplicate, not re-created.
- **`/api/v1/bonds` — bond lifecycle.** Purpose: create, fund-track,
  lock/unlock view, release, withdraw-intent. Auth: operator. Authorization:
  owning operator only. Input: `agentId`, amount/commitment concept, policy
  version ack. Output: `bondId`, state, `txRefs`. Idempotency: one active
  bond per agent enforced; duplicate create returns existing `PENDING`.
- **`/api/v1/eligibility` — eligibility checks & ZK verification intake.**
  Purpose: evaluate/submit eligibility (incl. proof artifacts as opaque
  blobs — never parsed by policy here). Auth: operator for private paths.
  Output: boolean statement + policy version + scope. Idempotency: proof
  resubmission deduped by artifact hash (concept; mechanism
  **[VERIFY-MIDNIGHT]**).
- **`/api/v1/risk` — flags & evidence.** Purpose: submit evidence, list
  flags, read flag detail (privacy-gated). Auth: operator (+ entitled
  reviewers). Authorization: evidence visible only to entitled parties.
  Input: evidence descriptor + content/hash; Output: flag summaries.
  Idempotency: evidence deduped by content hash; flag emission deduped per
  detection batch.
- **`/api/v1/attestations` — attestor workflow.** Purpose: attestor inbox,
  verdict submission, decision read. Auth: attestor credentials (separate
  from operator auth). Authorization: assigned attestors submit verdicts;
  operators have read-only view of their own decisions. Idempotency:
  verdict keyed by (request, attestor); decision single-issuance per flag.
- **`/api/v1/slashes` — enforcement records.** Purpose: read-only for
  operators (enforcement is executed via attested on-chain path, not via a
  "slash" POST). Output: slash events + decision refs + tx status.
  Idempotency: n/a (no mutating endpoint by design — unauthorized slashing
  has no API surface).
- **`/api/v1/reputation` — standing.** Purpose: read current band/history
  (owner-full, public-summary per doc 12). No writes exist; updates are
  event-sourced (doc 07). Idempotency: n/a.
- **`/api/v1/public` — unauthenticated verification.** Purpose: doc 12
  queries. Auth: none. Rate-limited. Only public-safe projections; private
  fields must be unrepresentable in these responses (enforced by separate
  serializers, Phase 1 acceptance item).

## 10.2 Cross-cutting

- **Authentication:** session tokens initially; wallet-signature login and
  attestor credential separation are hardening items (doc 13), not Phase 0.
- **Idempotency:** required on all mutations; keys scoped per route family
  with bounded retention (retention window is a Phase 1 decision).
- **Privacy:** private evidence/amounts never leave entitled scopes; public
  routes use dedicated serializers reviewed against doc 08.
