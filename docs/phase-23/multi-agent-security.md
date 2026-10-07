# Phase 23 — Multi-Agent Security & Delegation (focused doc)

Bounded agent-to-agent authority grants with server-derived
attribution, flowing through the existing Policy → Risk →
Attestation → Enforcement pipeline. Advisory-compatible; no
enforcement authority is delegable.

**Delegation grants authority within a bounded scope; it does not
grant authority beyond the delegator's existing capabilities.**

**Delegation does not bypass agent policy, risk analysis,
attestation, or enforcement controls.**

## Model

`delegations`: `(id, delegator_agent_id, delegate_agent_id,
capabilities, scope, status, version, created_by, timestamps,
expires_at, revoked_at, revocation_reason)`. Statuses
`active/revoked/expired`; records are never deleted. Expiry is
evaluated dynamically against `expires_at` (the security
authority), materialized opportunistically. `CHECK (delegator <>
delegate)`; indexes on delegator, delegate, status, expiry. No
secrets in records, ever. Protocol tag `delegation-v1` (new;
Phase 20/21/22 versions untouched).

Capabilities are authentication capabilities only
(`activity:submit`, `agent:read`, `risk:read`,
`verification:read`, `reputation:read`) — the closed
`DELEGABLE_CAPABILITIES` set. Enforcement, withdrawal,
policy-write, and credential management are operator-only routes
unreachable with agent principals, so they cannot be delegated.

Scope (all optional, null = unconstrained): `actionTypes`,
`tools`, `models`, `providers` — allowlists bounding what the
delegate may do with the granted capability. Scope never widens
anything; it only narrows.

## Capability inheritance (no escalation)

Delegated ⊆ delegable-set ∩ delegator's live capabilities, where
"live" = union over the delegator's active, unexpired credentials
(authority belongs to the agent; credentials are keys). Checked at
creation AND at every use: revoking the delegator's credential
fail-closes live delegations without touching the record. Both
agents must share the creating operator — cross-operator
delegation fails on ownership. Agent creators may only delegate
as themselves.

## Lifecycle

CREATE (validated, idempotency-key compatible) → ACTIVE →
REVOKE (durable, idempotent, version-bumped) or dynamic EXPIRE.
Revoked/expired delegations fail authorization immediately with
generic 403s; unknown ids fail identically (no existence oracle).
Concurrent creations serialize on natural keys (no fork; losers
get explicit conflicts); revoke/use races resolve to either a
fully-attributed success or a clean denial — never corruption.

## Authorization (centralized predicate)

Delegate identity → revocation → expiry → capability membership →
delegator live possession → operation scope. First failure wins;
`delegation.authorization_failed` audits the reason code while the
API returns generic `DELEGATION_DENIED`. Scope is enforced before
risk evaluation (authorization boundary, not a scored finding).

## Attribution

Every delegated analysis persists `(requester, executor,
delegation)` on the ledger row and in `RISK_FLAG_RAISED`
payloads: `requesterAgentId` = delegator (authority source),
`executorAgentId` = delegate (never replaced), `delegationId` =
authorizing grant. Direct activity maps to self-attribution, so
non-delegated payloads are byte-compatible (new `attribution`
object is additive). Server-derived only — client-supplied
requester claims are ignored.

## Phase interactions

- **Policy (22):** the executor's persisted policy governs;
  delegation scope adds a further restriction. Scope denial → 403;
  policy breaches → ordinary v3 findings. Delegation never
  overrides policy.
- **Risk (20):** delegated analyses run the full engine +
  behavioral detectors; executor history accumulates normally, so
  repeat violators are still caught.
- **Reputation (21):** flags attribute to the executor, so the
  existing `risk_flag_observed` hook debits the executor;
  delegators incur no automatic blame but stay identifiable via
  attribution. Verified outcomes preserve both identities.
- **Attestation/enforcement:** unchanged; flags from delegated
  activity are ordinary flags.

## API

- `POST /agents/:id/delegations` (operator owning `:id`, or `:id`
  itself as agent; idempotency-key compatible)
- `GET /agents/:id/delegations?role=&live=&limit=` (owner or self)
- `GET /delegations/:id` (delegator, delegate, or either operator)
- `POST /delegations/:id/revoke` (delegator agent or its operator;
  idempotent)
- `POST /risk/analyses` accepts optional `delegationId`
  (executor binding still holds; capability deferred to the live
  delegation check; response gains `attribution`)
- `GET /risk/flags*` accept `?delegationId=` for delegator-scoped
  reads (requested agent must equal the delegator)

## SDKs

Operator: create/list/get/revoke (TS + Python). Agent: same four
scoped explicitly by agent id (server enforces self); delegated
submit via `analyzeActivity(agentId, activity, delegationId)`.
No privileged operations on `BondAgentClient` (surface allowlists
updated and tested).

## Threat model (tested)

Possession-gated creation, closed capability set, live rechecks,
scope/expiry/revocation enforcement, wrong-delegate and
cross-operator denial without oracles, policy non-bypass,
no policy/bond/transaction authority via delegation, replay and
concurrency safety, attribution correctness, secret/content
hygiene, unchanged public surface.

## Limitations

- Delegations authorize API operations only, never chain effects.
- Expiry materialization is opportunistic; dynamic evaluation is
  authoritative.
- Delegated reads cover risk flags, not full agent records.
- No delegation chains (a delegate cannot re-delegate authority
  it holds only via delegation — possession is credential-based).
- Usage-window accounting attributes to the executor alone.
