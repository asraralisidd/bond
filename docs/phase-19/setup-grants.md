# Phase 19 — Delegated Setup Grants + Credential Lifecycle (focused doc)

Operator-minted, single-use, scope-bound setup passes for the three
bootstrap operations. No sessions, no privilege, no new infrastructure —
this document covers grants, the credential lifecycle policy, and the
integration flow, not the full Phase 19 scope.

## Grants

`POST /api/v1/setup-grants` (operator only) mints a grant; the secret is
returned **once** alongside metadata and stored as SHA-256 only.

- `scopes`: non-empty subset of `agent:register`, `bond:init`,
  `attestation:init`. Unknown scopes are 400.
- `agentId`: required for `bond:init`/`attestation:init` (binding to an
  existing owned agent), forbidden for `agent:register`.
- `expiresAt`: optional; default 15 min, capped at 60 min.

Grant bearers (`grant_<id>.<secret>`) are accepted only on the three
setup routes, each with its scope:

- `POST /api/v1/agents` requires `agent:register`.
- `POST /api/v1/bonds` requires `bond:init` plus agent-binding match.
- `POST /api/v1/attestations` requires `attestation:init` plus
  agent-binding match and flag ownership (existing rule, unchanged).

## Consumption semantics

- **Atomic**: one conditional UPDATE consumes; exactly one concurrent
  consumer wins, losers get a generic 401.
- **Consume-first**: the grant is spent even when a later check (scope,
  binding, validation) fails. Burns are fail-closed and intentional —
  pre-read-then-consume would reopen the TOCTOU window.
- **No escalation**: a consumed grant never becomes a session,
  credential, or operator principal. `requireOperator` rejects grant
  markers; grant bearers on any other route fail at session lookup
  (401). Grants cannot list, revoke, or mint other grants.
- **Generic 401s**: wrong secret, unknown id, expiry, revocation, replay,
  and lost races are indistinguishable (`UNAUTHORIZED`, same message).
- Out-of-scope use of a valid grant is 403 and still burns the grant.

Management (`GET` list, `DELETE` revoke) is operator-only and scoped to
the operator's own grants; cross-operator access is 404. List/revoke
never expose secrets.

## Credential lifecycle policy (Phase 18 semantics preserved)

- New credentials default to 90-day expiry when `expiresAt` is omitted;
  explicit expiries beyond 365 days are 400. Existing credentials are
  untouched (no mass-expiry, no migration).
- At most **5 active** credentials per agent; the 6th create is 400
  until one is revoked or expires. Rotation (revoke + reissue atomic)
  is unchanged and counts normally against the cap.
- Denials emit `credential.policy_denied` audit events; secret hygiene
  is unchanged (single disclosure, metadata-only list, hash-only
  storage).

## Audit events

`setup_grant.created` / `.consumed` / `.revoked` /
`.authentication_failed` in `protocol_events`, payloads carry ids and
scopes only — never secrets. Unbound-grant events have `agentId` NULL
(no agent exists yet) and are operator-invisible under the existing
feed model; bound-grant `.consumed` events carry the agent id and
surface in the operator feed. Verify unbound lifecycles via
`protocol_events` directly.

## Integration flow (SDKs + demo)

1. Operator: `client.createSetupGrant({ scopes: ["agent:register"] })`
   → `{ metadata, secret }`. Display the id; the secret lives only in
   memory.
2. Setup actor: present `grantId.secret` as the bearer on the setup
   route. The server consumes it exactly once.
3. Operator: `client.createAgentCredential(agentId)` → per-agent
   credential for all subsequent agent-scoped reads/activity.
4. End of run: revoke the credential; list/revoke grants as needed.

TypeScript: `createSetupGrant` / `listSetupGrants` / `revokeSetupGrant`
on `BondClient`; `SetupGrantMetadata` / `SetupGrantSecret` types.
Python: `create_setup_grant` / `list_setup_grants` /
`revoke_setup_grant`. The Phase 17 AI-agent demo registers through a
fresh grant on every run (reruns burn one grant on the duplicate-triple
recovery path, then reuse the existing agent).
