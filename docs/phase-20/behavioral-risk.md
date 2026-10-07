# Phase 20 — Behavioral Risk (deterministic, advisory)

Agent-scoped statistical intelligence over the agent's own recent
activity. No ML, no new infrastructure, no enforcement changes.

## Architecture

```
analyzeActivityService
  ├─ v1 engine (pure, unchanged) ──→ v1 findings
  ├─ bounded ledger + flag windows (agent-scoped, ≤500 rows)
  ├─ evaluateBehavioral (pure) ────→ behavioral findings
  ├─ scoreWithBehavioral (v2 when behavioral present, else v1 object)
  └─ single transaction: analysis + flags + ledger + events
```

The Risk Engine stays advisory: `Risk Engine → RiskFlag →
Attestor → Enforcement`. Behavioral code cannot import attestation,
slash, bond, wallet, Midnight, chain, or DB modules (proven by
`boundary.test.ts`, which scans source text after stripping comments
and string literals).

## Ledger

`agent_activity_ledger` (migration `013`): one server-written row per
analysis — `analysis_id` PK (idempotent), `action_type`, `action`,
`tool`, `amount_minor_units`, `bytes_out`, client `occurred_at`,
server `created_at`. Index `(agent_id, created_at DESC)`.

Privacy (same PRIVATE convention as bond commitments): action/tool/
amount visible to the owning operator and own agent only. Never
persisted: `textSnippet`, metadata, secrets, tokens. Never emitted in
events, feed payloads, evidence descriptors, or logs. Behavioral
explanations name at most the tool and observed counts.

Windows use `created_at` exclusively. `occurred_at` is a client claim
(display only) — backdating it cannot move a row into or out of a
window. No UPDATE/DELETE endpoint exists. Retention: opportunistic
bounded purge (>90 days, 1000 rows/run, best-effort after analysis,
never failing analysis) following the Phase 13 challenge-cleanup
pattern — no scheduler, no worker redesign.

## Detectors (`packages/risk-engine/src/behavioral.ts`)

Pure functions over `(current, history, categories, nowMs)`. Integer
arithmetic only (BigInt for money; zero floats). Stable order:
burst → velocity → novel-tool → repeat-violation.

- `activity-burst` — analyses in `windowHours` (default 1) over
  `burstCount` (default 10) → medium; ≥3× threshold → high.
  `"14 analyses in 60 minutes vs limit 10."`
- `spend-velocity` — Σ amounts in window over
  `spendLimit × velocityMultiple` (default 3) → medium; ratio ≥3 →
  high. Skipped without a numeric limit.
- `novel-tool` — tool absent from the trailing `baselineDays`
  (default 7) with ≥3 baseline rows → **low only**. A first-seen tool
  is expected after upgrades: signal, never punishment.
- `repeat-violation` — prior same-category flags (open/under-review/
  attested; dismissed/expired were reviewed away and don't count) plus
  current ≥ `repeatCount` (default 3) in `repeatWindowHours`
  (default 24) → high. Monotonic: sustained violations only add.

## Thresholds

Optional `policyContext.behavioralThresholds`: `windowHours`,
`burstCount`, `velocityMultiple`, `baselineDays`, `repeatCount`,
`repeatWindowHours`. Validated integers with ranges at normalization;
invalid values are `INVALID_ACTIVITY_INPUT` (400), never silently
accepted. Resolved thresholds travel with the analysis, so every
result is reproducible from its inputs. No environment reads, no
hidden global config.

## Scoring and versioning

`scoring-v1` and `scoreFindings` are byte-frozen: v1-only analyses
keep identical findings, scores, severity, and stamps
(`engine-v1` / `ruleset-v1` / `scoring-v1`, asserted by unchanged
protocol vectors and regression tests).

`scoreWithBehavioral(v1, behavioral)` (new, additive) returns the v1
object untouched when no behavioral findings exist. Otherwise:

```
total = min(100, max(v1, behavioralSub) + min(8, 2 × (n − 1)))
```

The v1 score is the floor; the behavioral addition lands on the first
behavioral factor. Behavioral flags stamp `ruleset-v2` / `scoring-v2`
(`bond-risk-engine/engine-v1 ruleset/ruleset-v2 scoring/scoring-v2`);
v1 flags keep v1 stamps. `RiskScore.scoringVersion` and
`RuleExplanation.ruleVersion` were widened `literal → string`
(additive; v1 paths still emit the exact v1 tags).

## Why behavioral findings cannot become CRITICAL

Statistics describe populations, not intent: a burst can be a batch
job, a novel tool an upgrade, velocity a limit misconfiguration.
CRITICAL implies slash-grade certainty the math cannot provide.
The ceiling (high) plus mandatory attestor quorum keeps false
positives advisory. The `behavioralAnomalyPlaceholder`
(`kind: "ml-placeholder"`, always empty) is untouched and still
pinned by its test.

## Why ML remains a placeholder

Deterministic thresholds are explainable ("14 vs limit 10"),
reproducible, provider-agnostic, and dependency-free (`boundary`
test requires risk-engine deps `== ["@bond/shared-types"]`). An ML
classifier would add non-determinism, model versioning/storage, and a
training-data poisoning surface with no proven need at this volume.
If ML ever ships, it implements `ActivityAnalyzer` behind a new
ruleset tag — this design doesn't preclude it.

## Replay handling

Identical activity re-derives the identical analysis ID. The service
pre-checks for an existing analysis and concurrent races fail on the
analysis PK; both map to `REPLAYED_ACTIVITY` (409, following the
existing `REPLAYED_*` convention) instead of the previous loud
500-class failure. Ledger inserts are `ON CONFLICT DO NOTHING`, so
replays cannot duplicate behavioral state or poison baselines.
Concurrent duplicates admit exactly one analysis (tested with 5-way
races).

## Performance

Per analysis: +1 bounded SELECT pair (ledger window + flag window,
`LIMIT 500`, composite index) and +1 ledger INSERT. `EXPLAIN`
proves the window query uses `activity_ledger_agent_time_idx` with
no sequential scan (seeded-volume test). No Redis/Kafka/background
work.

## Limitations

- Windows are диагностика over server receive time, not client
  event time (by anti-spoofing design).
- New agents (< 3 baseline rows) get no `novel-tool` coverage.
- Score-drift, sequence anomalies, and cross-agent correlation are
  explicitly out of scope.
- Retention is opportunistic: a quiet instance purges lazily.
- `GET /risk/behavior`, SDK helpers, and dashboard panels are
  deferred SHOULD features, not implemented here.

## Demo

`BOND_DEMO_SCENARIO=behavioral`: 19 scripted steps (+60s occurredAt)
— 3 baseline → 8 burst → 4 velocity → 1 novel tool → 3 denylist
violations — using default thresholds. Output lists per-step
behavioral rule IDs, the distinct rule-ID set with severity/
category, and the v2 model versions. No AI provider, no randomness,
no chain. Reruns reuse the deterministic agent ref, so history
accumulates across runs (documented, realistic).
