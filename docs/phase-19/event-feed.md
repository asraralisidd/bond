# Phase 19.1 — Event Feed API (focused doc)

Pollable, cursor-paginated reads over the append-only
`protocol_events` table. No webhooks, SSE, push, brokers, or new
infrastructure — this document covers the endpoint only, not the full
Phase 19 scope.

## Endpoint

`GET /api/v1/events?limit=50&cursor=<opaque>&type=<TYPE>`

- `limit`: integer 1–100, default 50. Anything else is 400.
- `cursor`: opaque base64url blob from a previous `nextCursor`.
  Malformed cursors are 400. Never hand-construct one.
- `type`: optional exact event-type filter (e.g. `RISK_FLAG_RAISED`).
  Unknown types match nothing (200, empty page).

Response: `{ data: { events: [...], nextCursor: string | null } }`.
`nextCursor: null` means the end. Page by following cursors until
null; pages are disjoint and lossless under the `(created_at, id)`
ordering.

## Authentication model

- Operator sessions: full owned scope, no capability checks.
- Agent credentials: require the `risk:read` capability (the same
  capability that governs own-findings reads on `/risk/flags*`;
  reusing it grants no new data since every returned event is about
  the caller's own agent). Anything else is 403 plus an
  `agent.capability_denied` audit event.
- Unauthenticated callers: 401. Attestor/system principals: unchanged
  behavior (not granted feed access).

## Visibility rules

Scope derives from the authenticated principal, never from input:

- Operator → events whose `agent_id` belongs to an agent they own.
- Agent → events whose `agent_id` equals their own agent only.
- Supplying another agent's id anywhere changes nothing: there is no
  agent-id parameter to tamper with.

## Response privacy

Each item: `id, type, agentId, bondId, txId, actor, policyVersion,
requestId, createdAt, payload`. Payloads are producer-scrubbed by the
existing store contract and every field is already visible to these
principals through existing endpoints. Never present: credentials,
hashes, keys, witnesses, amounts beyond what resource endpoints
already expose, raw bodies, or database internals. The cursor carries
only a timestamp and a row id.

## Rate limiting and correlation

Global `read` baseline plus per-route `read` with identity-aware
buckets (`agent:{id}` / `op:{id}` / IP fallback). Standard
`x-request-id` echo; `Retry-After` + `RATE_LIMITED` on 429 like
everywhere else. Reads never emit protocol events (no recursion).

## SDK surface

- TypeScript: `client.listEvents({ limit, cursor, type })`,
  `agentClient.listEvents(...)`, `EventFeedItem`/`EventFeedPage` types.
- Python: `client.list_events(limit, cursor, event_type)` and the same
  on `BondAgentClient`.
