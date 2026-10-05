# 14 — Observability (lightweight)

## 14.1 Correlation IDs (required on every flow)

- `requestId` — one per inbound API call, returned to the caller and
  attached to all downstream records and logs.
- `agentId` — on all agent-scoped records and events.
- `riskId` (`riskFlagId`) — on detection, assessment, flag, and
  attestation-request records.
- `attestationId` (`requestId`/`decisionId`) — on verdicts, decisions, and
  enforcement records.
- `transactionId` (chain ref when known) — on intents, submissions,
  confirmations, and all bond/fund state changes.

## 14.2 Structured events & audit trail

- Every state transition in docs 03/04 emits a `protocol_event`
  (entity, from→to, cause, actor, policy version, timestamp). The audit log
  is append-only and queryable per agent/operator (privacy-gated).
- Logs are structured (JSON concept) with the IDs above; **no private
  content in logs** — reference evidence by hash/id, never by value.
- Backend exposes a lightweight health + readiness surface (extends the
  existing `/health` shell); chain-mirror lag is a first-class metric
  (stale-mirror alert per doc 13 threat 14).

## 14.3 Explicitly lightweight

Standard application logging + Postgres-backed events + health checks are
sufficient for the initial build. No Kafka, Elasticsearch, service mesh, or
distributed tracing infrastructure (see ADR-007). Revisit only on a
demonstrated requirement (e.g. volume that Postgres event queries cannot
serve — measure first).
