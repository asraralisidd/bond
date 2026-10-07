# Phase 22 — Policy & Capability Engine (focused doc)

Versioned, deterministic operational policies governing what an AI
agent may do. Authorization/risk-input layer only — advisory, never
enforcement.

## Two capability kinds (do not confuse them)

- **Authentication capabilities** (`activity:submit`, `agent:read`,
  `risk:read`, `verification:read`, `reputation:read`): what an agent
  credential may ask the API for. Unchanged by Phase 22.
- **Operational capabilities** (tools, actions, models/providers,
  tokens, cost, requests, transfers): what an agent may DO in the
  world. Governed by agent policies (this phase).

## Architecture

```
Operator → agent_policies (versioned, immutable history)
                ↓ effective context overlay
Activity → Policy Evaluation → PolicyDecision → Risk Analysis
                                                      ↓ (v3 findings)
                                              RiskFlag → Attestors
```

`Policy Engine → PolicyDecision → Risk Engine → RiskFlag →
Attestors → Enforcement → Bond`. The policy package imports only
shared-types (proven by its boundary test); it cannot slash, sign,
submit, attest, or touch chain state. Policy violations become
ordinary risk flags (observed risk → existing Phase 21 hook weight);
no second enforcement pipeline exists.

## Policy model

`agent_policies`: `(id, agent_id, version, status)` + allow/deny
lists (actions, tools, providers, models) + token/request/cost/
transfer limits and windows + `created_by`. `UNIQUE (agent_id,
version)`; one ACTIVE per agent. Versions never mutate: PATCH
amends by inserting the next version behind an `expectedVersion`
gate (stale → 409 `POLICY_VERSION_CONFLICT`, never silent loss).
`POLICY_CREATED` / `POLICY_UPDATED` protocol events make every
change auditable. No secrets in policies, ever.

Field semantics: null = unconstrained; a present list — even empty
— is enforced (empty allowed = deny-all); deny wins over allow;
windowed pairs (limit + window seconds) are all-or-nothing, rejected
when half-configured. Money stays digit strings; tokens/counts are
bounded integers.

## Effective context (server authority)

At analysis time the persisted policy overlays the
caller-supplied context for governed fields: persisted allowlists
and transfer caps win; denies union/subtract monotonically
(including an empty-declared fallback so tool denies are always
expressible). A client cannot self-authorize with a permissive
context once a policy exists. Without a persisted policy the
caller context passes through untouched — legacy behavior,
byte-identical (v1 stamps, existing vectors green).

Division of labor (no duplication): action/tool/transfer
constraints flow through risk-engine v1 rules over the effective
context; the policy evaluator owns only provider/model gates,
per-activity token/cost caps, and cumulative token/cost/request
windows.

## Model / token / cost support (provider-agnostic)

Normalized activity gains optional adapter-supplied fields:
`provider`, `model`, `inputTokens`, `outputTokens`,
`totalTokens`, `estimatedCostMinorUnits`. SDK builders (TS/Python)
validate and emit them only when set — protocol vectors unchanged.
No provider SDKs, no provider packages, no billing APIs.

**BOND does not assume a provider's billing model. Provider
adapters provide normalized usage data; authoritative cost is only
available when the adapter provides it.** Cost explanations state
this explicitly.

## Limit evaluation

Per-activity caps compare directly; cumulative windows aggregate
server-side from the ledger (`provider/model/token/cost` columns,
added nullable in migration 015) with exact `COUNT(*)`/`SUM`
over `created_at` (never client timestamps), one indexed query per
configured window. Usage rows before the window are invisible by
construction; limits without usage data stay quiet.

## Violations

`MODEL_NOT_ALLOWED`, `PROVIDER_NOT_ALLOWED`, `TOOL_NOT_ALLOWED`
(via v1 over effective context), `ACTION_NOT_ALLOWED` (ditto),
`INPUT/OUTPUT/TOTAL_TOKEN_LIMIT`, `REQUEST_RATE_LIMIT`,
`COST_LIMIT`, `TRANSFER_LIMIT` (via v1 spend rule). Each carries
ruleId, severity (hard caps high; windows medium→high at 2× over;
never critical), policyVersion (`agent-policy-vN`), observed and
threshold values, and a one-sentence explanation. Response payloads
include the full `policy: {allowed, violations, policyVersion,
source}` decision.

## Risk integration (ruleset-v3 / scoring-v3)

Policy violations convert to rule findings (`ruleVersion:
policy-v1`) and score through additive `scoreWithPolicy`
(`min(100, max(base, policy) + min(8, 2(n−1)))`); v1 and v2 paths
are frozen — analyses without policy findings keep exact v1/v2
stamps. Flags carry
`bond-risk-engine/engine-v1 ruleset/ruleset-v3 scoring/scoring-v3`.
Policy findings are observed risk: the Phase 21
`risk_flag_observed` hook weights them by severity, exactly like
any other flag. No reputation change flows from an unverified
policy decision beyond that hook.

## Behavioral interplay

Policy establishes constraints; behavioral intelligence detects
patterns — no shared calculations. Persisted transfer caps feed
v1 spend evaluation; per-activity behavioral thresholds are
unchanged. A burst of policy-violating activity correctly raises
both policy and behavioral flags (demonstrated in scenario E).

## API

Operator-only mutations (`requireOperator`; grant bearers rejected):
`POST /agents/:id/policy` (idempotency-key compatible),
`PATCH /agents/:id/policy` (`expectedVersion` gate). Reads
(`GET` effective, `GET .../policy/history?limit=`) follow the
agent-route convention (`agent:read` + self + ownership); agents
read only their own policy and can never mutate.

## SDKs

Operator: create/get/update/history (TS + Python). Agent:
read-only own effective policy. Builders accept the new usage
fields with client-side validation; omitted fields stay absent
(vectors unaffected).

## Security / privacy

Tested: cross-agent/cross-operator denial, agent-mutation denial,
malformed/negative/overflow inputs, half-paired windows, stale and
concurrent updates (no forks), replay/idempotency, secret and raw-
content scans of decisions/events/flags, public surface unchanged,
boundary import scans, no enforcement imports. Policies and
decisions carry identifiers and counts only.

## Limitations

- Windows are server-receive-time; usage before retention purges
  (90-day ledger) ages out of cumulative windows.
- Exact window aggregates scan the window's rows; very hot agents
  with very long windows pay linear aggregation per analysis
  (bounded by policy configuration, no background rollups).
- Empty-allowed semantics are strict (deny-all); operators must set
  explicit allowlists or leave fields absent.
- No decay, no delegation, no multi-agent policies, no UI.
