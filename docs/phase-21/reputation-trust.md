# Phase 21 — Reputation & Trust Intelligence (focused doc)

Event-sourced, deterministic trust scores over verified protocol
outcomes. Advisory only — no enforcement authority.

**Reputation is advisory trust intelligence and does not directly
authorize or execute enforcement.**

## Architecture

```
Risk Engine → RiskFlag → Independent Attestors → Verified Decision
                                                        ↓
                                              Reputation Engine
                                              (score + trust level)
```

separately: `Verified Decision → Enforcement → Bond/Collateral`.

Two tracks coexist by design:

- **v0 snapshots** (`deriveReputation`, `reputation_records`,
  `refreshReputation` on enforcement/withdraw finalizers): aggregate
  recount — 100 −25/full-slash −10/partial −5/confirmed-flag
  +5/clean-bond +3/remediated; standings good/probation/poor;
  feeds the existing public verification view. Frozen; Phase 21 does
  not touch it.
- **v1 events** (this phase): discrete impacts from individual
  protocol outcomes, stored in `reputation_events`, current state in
  `agent_reputation`, served by `GET /agents/:id/reputation`.

## Event types and impact policy (`reputation-v1`, integers only)

| Event                   | Source               | Impact                    |
| ----------------------- | -------------------- | ------------------------- |
| `risk_flag_observed`    | risk flag            | −1/−2/−5/−8 by severity   |
| `attested_violation`    | attestation decided  | −3/−6/−12/−20 by severity |
| `attestation_dismissed` | attestation rejected | +2                        |
| `slash_enforced`        | slash event          | −15 partial, −30 full     |
| `clean_bond_completed`  | bond WITHDRAWN       | +3                        |

Observed risk is always weaker than the matching verified outcome.
Positives flow only from verified outcomes (dismissal, clean
withdrawal) — raw activity, however benign, never raises reputation,
so scores cannot be farmed by submitting clean analyses. Clamp
`0 ≤ score ≤ 100`. Baseline for history-free agents: **75 (HIGH)** —
mid-HIGH so single small observations preserve the band while one
attested violation leaves it; consistent with v0's `good ≥ 70`.

## Trust levels

`VERY_HIGH 90–100`, `HIGH 70–89`, `MODERATE 50–69`, `LOW 25–49`,
`VERY_LOW 0–24` — nesting inside v0 standings (poor ⊂ VERY_LOW/LOW,
probation ⊂ LOW/MODERATE, good ⊂ MODERATE/HIGH/VERY_HIGH).

## Explainability

Every event stores: event type, source (type + id), impact, score
before/after, reason code (`OBSERVED_HIGH_RISK`,
`ATTESTED_CRITICAL_VIOLATION`, `SLASH_FULL`, …), human reason,
`reputation-v1` stamp. Reasons name categories/severities only —
never evidence content, activity text, metadata, or secrets.

## Idempotency

Event id `repev-{sourceType}-{sourceId}` + `UNIQUE (agent_id,
source_type, source_id)` + `ON CONFLICT DO NOTHING`. Pre-check
returns the existing outcome (`applied: false`); losers of a
concurrent duplicate race re-read the winner. Same-agent distinct
events serialize on `SELECT … FOR UPDATE` of the state row. Ledger
and flags are untouched by retries (409 paths return before writes).

## Hooks (all in the originating transaction)

- Flag insert (`services/risk.ts`) → `risk_flag_observed`.
- Decision issued (`issueDecisionService`) → `attested_violation`.
- Verdict-quorum rejection (`submitVerdictService`) and
  auto-evaluation rejection → flag dismissed + `attestation_dismissed`.
- ENFORCEMENT finalizer after slash completion → `slash_enforced`.
- WITHDRAW finalizer on WITHDRAWN → `clean_bond_completed`.

## API

`GET /api/v1/agents/:id/reputation?limit=` (default 20, max 100,
newest first, no offsets): `{agentId, score, trustLevel, version,
updatedAt, events[]}`. Auth follows the agent route convention:
`requireAgentOrOperator` + `reputation:read` capability (new,
default-issued with all other capabilities; pre-existing credentials
keep their stored sets) + `requireSelfAgent` + ownership check.
Operators read owned agents only; agents read only themselves.
Reads never write (baseline is synthesized). Public verification is
unchanged (v0 standing only, no history, no score).

## SDKs

`BondClient.getAgentReputation(id, limit)` (operator) and
`BondAgentClient.getReputation(id, limit)` (agent, server-enforced
self) in TS and Python, with view types, coverage tests, and
updated capability-count assertions.

## Security / privacy

Isolation tests: cross-agent 403, cross-operator 403, capability
denial without the grant, no ledger-style write surface (reputation
has no POST/PUT/DELETE), payload scans for secret-bearing tokens,
event-feed payloads carry ids/impacts only. Reputation service
imports no attestor/bond/wallet/chain modules (import-graph
assertable; engine itself lives in shared-types with only
`DomainError` + type imports).

## Performance

Per hooked outcome: +1 state read (PK), +1 event insert, +1 state
upsert, +1 bounded history read on GET (`(agent_id, created_at
DESC)`, `LIMIT ≤ 100`). No scans, no new infrastructure.

## Limitations / future

- Score moves only on protocol outcomes (flags, attestations,
  slashes, withdrawals) — quiet agents sit at baseline.
- v0 snapshots and v1 state are maintained by different triggers;
  both advisory, neither gates enforcement.
- No decay, no dispute flow, no cross-agent signals, no ML —
  deferred by design (see OUT OF SCOPE).
- Retention: event log is audit history and is never purged.

## Demo

`BOND_DEMO_SCENARIO=reputation`: baseline (75 HIGH) → benign
activity (preserved) → risky activity (observed dip) → quorum
confirm + decision (verified dip) → simulated enforcement. Prints
per-stage score/trust/version plus the full event history with
impacts and reasons. Slash-deepening runs only on worker-confirmed
slashes (covered by API tests, not the simulated demo path).
