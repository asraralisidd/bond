# BOND Phase 1 — Domain Model

> All domain code lives in `packages/shared-types/src/`. Pure TypeScript,
> zero runtime dependencies, no I/O, no chain, no crypto, no AI. Later
> phases consume these contracts; nothing here calls outward.

## 1. Phase 1 purpose

Establish the stable, strongly typed domain foundation: every entity,
lifecycle, event, error, and privacy projection the protocol needs —
specified once, tested, and frozen as `v0` concepts — so Phase 2 (Risk
Engine) can build on `RiskFlag` without redefining the language.

## 2. Domain model overview

| Module             | Contents                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| `ids.ts`           | 12 branded IDs + `parseXId` validators (generation is infra, not here)  |
| `enums.ts`         | All lifecycle/severity/category/verdict/action/event vocabularies       |
| `errors.ts`        | `DomainError` with stable machine-readable `code` + `details`           |
| `agent.ts`         | `Agent` record + deterministic lifecycle (ATTESTED resolved out)        |
| `bond.ts`          | `Bond` + `BondCommitment` (opaque, private amount) + lifecycle          |
| `risk-flag.ts`     | Advisory `RiskFlag`, evidence-hash refs, validation, status transitions |
| `attestation.ts`   | Request → verdicts → quorum → single decision, expiry, replay helpers   |
| `slash-event.ts`   | Immutable enforcement record, `initiated → completed` exactly once      |
| `reputation.ts`    | Deterministic `v0` derivation (`REPUTATION_MODEL_VERSION`), no tokens   |
| `transaction.ts`   | Chain-operation states as a pure machine; `CONFIRMED` gates successors  |
| `events.ts`        | Typed `ProtocolEvent` union + factories; JSON-serializable, versioned   |
| `projections.ts`   | Allowlisted public views + `verifyAgentPublic` rules `v0`               |
| `observability.ts` | ID-only `DomainLogMetadata`; no parameter slot for private content      |
| `transport.ts`     | Unchanged foundation shell (`HealthResponse`, `ApiResponse`)            |

## 3. Identifier strategy

Branded strings (`AgentId`, `BondId`, …): same runtime cost as strings,
compile-time mixing prevention (proven by a `@ts-expect-error` test).
Validation-only `parseXId` functions reject empty / non-string /
over-long values with `INVALID_IDENTIFIER`. Generation (UUIDs, sequences)
belongs to infrastructure and is deliberately absent.

## 4. Agent state machine

States: `UNREGISTERED → REGISTERED → BONDED → ELIGIBLE → ACTIVE`,
with `FLAGGED` (auto on flag), `SLASHED` (enforcement executed),
`SUSPENDED` (pause, resumes to prior durable state), `RESOLVED`
(incident closed), and terminal `WITHDRAWABLE`. Key enforced rules:
bond before eligibility; `SLASHED` recovers only via `RESOLVED`;
`WITHDRAWABLE` has no outgoing transitions (a new bond starts a new
lifecycle). All transitions go through `transitionAgentStatus`
(deterministic, pure, throws `INVALID_AGENT_TRANSITION` with
`{from, to}`).

## 5. Bond state machine

`CREATED → PENDING → ACTIVE ⇄ LOCKED`, with `→ PARTIALLY_SLASHED →
FULLY_SLASHED`, `→ WITHDRAWABLE → WITHDRAWN`, plus `FAILED`/`CANCELLED`
terminals. Terminals: `FULLY_SLASHED`, `WITHDRAWN`, `FAILED`,
`CANCELLED`. Two smallest-safe clarifications over Phase 0 text:
`PENDING → CANCELLED` allowed (still "before activation"), and
`ACTIVE|LOCKED → FULLY_SLASHED` allowed (one enforcement may exhaust
collateral). No return from `PARTIALLY_SLASHED` to `ACTIVE`. Amounts are
opaque minor-unit strings, private by construction.

## 6. RiskFlag model

Advisory only: `category` (7 Phase 0 categories), `severity`,
`confidence ∈ [0,1]`, ≥1 evidence-hash ref required, `modelVersion`
recorded for reproducibility, `supersedes` linkage for revisions,
`open → under-review → attested|dismissed|expired`. Construction
validates everything; the object carries no behavior and no chain
surface (a test asserts the exact key allowlist + JSON round-trip).

## 7. Attestation model

Request (threshold, policy version, expiry) → signed verdict slots
(`confirm|reject|abstain`, opaque `bindingRef` reserved for Phase 3+
crypto, duplicate-attestor and late-verdict rejection) → quorum
evaluation (configurable threshold; 2-of-3 is a policy value, not a
constant) → at most one `EnforcementDecision` (`partial-slash |
full-slash | dismiss`, unique nullifier, expiry). Freshness uses an
injected `nowIso` (no clock reads → deterministic tests).
`isDecisionReplay` checks nullifier consumption against a caller set;
on-chain consumption is a later phase.

## 8. SlashEvent model

Own object with `slashEventId/agentId/bondId/attestationId/decisionId/
riskFlagId`, category/severity, private amount, `isFullSlash` marker,
`initiated → completed` exactly once (double-complete throws), immutable
updates (originals untouched). Carries references, never private
content beyond the amount field — which projections exclude.

## 9. Reputation model

Event-sourced derivation (`triggeredByEvent` required), deterministic
`v0` weights (documented in code: −25/−10/−5, +5/+3, clamp [0,100]),
standings `good ≥70 / probation ≥40 / poor`. Dismissed flags must not
feed `confirmedFlags`. No tokens, no transfers, no editing — corrections
are new events. Weights are starting policy for Phase 2+ to refine.

## 10. Public/private projection boundary

Projections build fresh allowlisted objects — never spread internals —
so future private fields cannot leak. `verifyAgentPublic` implements
documented rules `v0` (untrusted on full slash/poor; trusted only for
bonded, flag-free, good-standing agents; caution otherwise —
soundness over completeness). Tests serialize every public view and
assert secret amounts, hashes, operator PII, and field names
(`amountMinorUnits`, `contentHash`, …) are absent.

## 11. Transaction lifecycle

`IDLE → WALLET_APPROVAL → PENDING → SUBMITTED → CONFIRMED`, with
`WALLET_APPROVAL → IDLE` (rejection returns to draft),
`PENDING|SUBMITTED → FAILED`, `FAILED → IDLE` (same-key retry), and
`CONFIRMED` terminal. `isConfirmedTransactionStatus` is the single gate
later phases use before successor actions. `chainRef` stays null until
`SUBMITTED`; no optimism is representable.

## 12. Domain events

Ten `ProtocolEventType`s covering registration, bonds, flags,
attestations, slashes, reputation, withdrawals, and tx changes.
Compile-time payload-per-type checking, `eventVersion: "v0"`,
`requestId` correlation, JSON round-trip tested. No broker, no
transport — shapes only.

## 13. Domain errors

Thirteen stable codes (`INVALID_*_TRANSITION`, `INVALID_ATTESTATION`,
`EXPIRED_ATTESTATION`, `REPLAYED_ATTESTATION`, `INVALID_IDENTIFIER`,
`INVALID_RISK_FLAG`, `INVALID_SLASH_EVENT`, `INVALID_SLASH_TRANSITION`,
`INVALID_REPUTATION_INPUT`, `INVALID_TIMESTAMP`), each with structured
`details` and no HTTP coupling.

## 14. ATTESTED decision

**Resolved: `ATTESTED` is not an Agent state.** It lives on the
Attestation/decision record (`AttestationStatus`: `requested |
quorum-met | decided | rejected | expired`). The agent moves
`FLAGGED → SLASHED` (enforcement) or `FLAGGED → RESOLVED` (dismissal);
a public "attested" badge is derivable from the linked decision. This
follows Phase 0's own default recommendation and avoids a duplicate
lifecycle. Any future need for an agent-visible attested marker must
come as a derived projection, not a stored state.

## 15. Design decisions

- Branded IDs over plain strings; validation without generation.
- Opaque string amounts (no floats); denomination kept, privacy decided
  per projection (bands only in public).
- Injected timestamps (`nowIso`) instead of clock reads for determinism.
- Opaque `bindingRef`/`nullifier` strings: integration slots with no
  invented crypto.
- `v0` tags on reputation weights, verification rules, and event
  versions with additive-evolution policy.
- `transport.ts` split out so foundation shell types stay untouched.

## 16. Remaining unresolved questions

From Phase 0 §15.4, still open (none blocking Phase 2): operator
transfer flow; on-chain registration anchoring; post-release liability
window; attestor admission/governance; shielded-amounts vs bands
(`BondCommitment` is shaped to allow either); reputation decay shape
(`v0` uses linear weights, no time decay yet).

## 17. Phase 1 acceptance criteria (status)

- [x] Ubiquitous language frozen in `enums.ts` + module docs.
- [x] Agent/bond/tx/flag lifecycles locked with invalid transitions
      enumerated and tested; ATTESTED question resolved (§14).
- [x] Concept inventories versioned (`v0`: reputation model,
      verification rules, event versions; additive-evolution policy).
- [x] Privacy gateways named (attestation decision, ZK verification
      slot, policy publication) and enforced by projections + tests.
- [x] API sketch input exists (Phase 0 doc 10; OpenAPI proper is Phase 7).
- [x] ID/event conventions adopted (`requestId` on events, log
      metadata, `protocol_event` emission points = every transition).
- [x] Open questions triaged (§16).
- [x] No implementation beyond domain: no tables, endpoints, contracts,
      chain, crypto, AI, or UI. Shell packages still throw
      `not-implemented`; `apps/*` untouched.
