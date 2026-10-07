# Phase 24 — Developer Platform & Integrations (focused doc)

Provider- and framework-neutral integration layer mapping external
AI usage into BOND's normalized activity model. BOND stays an
observer/enforcement layer: it never calls providers, never holds
provider credentials, and never makes model requests.

**BOND does not store provider API keys.**

## Architecture

```
Developer Agent ── provider credentials ──► AI Provider
       │
       │  normalized usage/activity (no secrets)
       ▼
Provider/Framework Adapter (SDK-side, pure mapping)
       ▼
BOND SDK (build_model_activity / ActivityInput)
       ▼
API → Phase 22 Policy → Phase 20 Risk → Phase 21 Reputation
       ▼ (Phase 23 attribution preserved throughout)
Attestation → Enforcement (unchanged)
```

## Provider-neutral usage model

`NormalizedModelUsage`: `provider` (required), `model`,
`inputTokens`, `outputTokens`, `totalTokens`,
`estimatedCostMinorUnits`, `providerRequestId` — all optional
except provider. This reuses (not duplicates) the Phase 22
`PolicyActivityUsage` shape; adapters output it, builders consume
it, the engine validates it, the ledger persists the counters.

Total rule (deterministic): an explicitly supplied total is kept
as provider authority even when it disagrees with input+output —
never silently rewritten. When absent, the total derives as
input+output only if a side is present; otherwise it stays
absent. Costs map only from explicit digit-string fields. **No
price tables exist in BOND: undocumented cost shapes stay absent
rather than fabricated.**

BOND does not assume a provider's billing model. Provider
adapters provide normalized usage data; authoritative cost is
only available when the adapter provides it.

## Provider adapters

Pure functions over caller-supplied response objects (mappings or
attribute objects — duck-typed, no provider packages installed):

- OpenAI (`usage.prompt/completion/total_tokens`, `model`, `id`)
- Anthropic (`usage.input/output_tokens`; total derived)
- Gemini (`usageMetadata.prompt/candidates/totalTokenCount`;
  model passed explicitly)
- DeepSeek (OpenAI-compatible envelope, separate module)
- Local/custom (common key aliases; self-identified provider)

Strict validation: non-negative safe integers only (bools,
floats, strings, negatives, and oversized values rejected);
unknown fields ignored, never serialized. Prompts, completions,
reasoning, and credentials are never read.

## Framework adapters

- LangGraph (existing, extended): `from_llm_call` maps a message
  plus normalized usage to a model activity.
- CrewAI, AutoGen: minimal duck-typed mappers for task/message/
  tool-call shapes.
- Generic boundary: caller-described events for custom
  frameworks — explicit mapping, same normalized output.

Adapters hold mapping configuration only: no network, no
credentials, no storage, no risk decisions. TypeScript ships
provider normalizers plus the generic boundary (framework-native
adapters live in Python, where those frameworks run).

## Model-call representation

`build_model_activity` emits `tool-call` / `model-invocation`
with no tool: provider/model attribution (not tool identity)
drives Phase 22 model/provider checks, so tool allowlists are
unaffected. Only minimal safe metadata persists; raw prompts,
responses, and reasoning are never required and must not be sent.

## Policy / risk / reputation / delegation

Normalized usage feeds the unchanged Phase 22 evaluator
(provider/model gates, token/cost limits, cumulative windows),
then the unchanged risk engine, flags, and reputation hooks.
Delegated model calls keep server-derived attribution — adapters
cannot spoof requester identity (they never set it; the server
derives it from the delegation record).

## SDK surface

`normalize_<provider>_usage`, `normalize_usage`,
`build_model_activity`, framework adapters (Python),
`describeFrameworkEvent` + providers (TypeScript). Shared
`usage.json` protocol vectors are validated by both SDKs.

## Privacy

Public verification exposes no prompts, responses, tokens,
costs, secrets, or framework internals. Usage stays scoped to
operator/agent authorization; events carry ids and counters
only. Secret-leakage scans cover payloads, logs, events, SDK
objects, and demo output.

## Limitations and assumptions

- [VERIFY-PROVIDER] response shapes follow public documented
  envelopes; provider API drift requires adapter key updates only.
- [VERIFY-FRAMEWORK] CrewAI/AutoGen shapes assume stable
  community conventions; version drift is isolated to extractors.
- Costs are estimates unless the adapter reports authoritative
  billing data (currently none do — all costs are estimates).
- Provider request ids are used as activity-id defaults only and
  are not separately persisted.
- No migration: usage persists via existing ledger columns;
  no new tables, no new infrastructure.
