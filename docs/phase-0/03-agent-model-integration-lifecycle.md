# 03 — Agent model, integration & lifecycle

## 3.1 Conceptual Agent model

An **Agent** is a registered claim by an operator about an external software
entity. BOND never runs the agent; it records, prices, and enforces against
the claim. Concept inventory (not columns, not fields — see doc 09 for
entity mapping):

- `agentId` — BOND-assigned stable identifier (UUID concept). External
  platform IDs are stored as _claims_, never as the primary identity.
- `owner/operator` — the operator account responsible for the bond and all
  chain actions. Exactly one operator per agent at a time; transfer is an
  explicit, auditable event (Phase 1 to specify).
- `platform` — free-form ecosystem label (`openai`, `langchain`, `custom`,
  …). Metadata only; must not branch core behavior (ADR-001).
- `agentType` — coarse category concept (e.g. conversational, coding,
  workflow, trading). Used for policy selection and display, not identity.
- `capabilities` — declared capability list (tools, permissions, spend
  limits). Compared against evidence during risk analysis; mismatches are a
  first-class risk category (doc 05).
- `identity` — how BOND recognizes the agent: `agentId` + operator binding +
  optional evidence-signing key (future; evidence authenticity only, never
  fund movement).
- `registrationStatus` / `operationalStatus` — see §3.3 state machine.
- `reputation` — derived summary pointer (detail in doc 07), not a token.
- `bondStatus` — pointer to the active bond lifecycle state (doc 04).
- `riskStatus` — derived worst/active flag summary (e.g. `clear`, `flagged`,
  `under-review`); always computed, never stored as authoritative truth.

## 3.2 Platform-agnostic integration

1. **How an external agent registers.** The operator (via dashboard or SDK)
   submits: platform label, agentType, declared capabilities, and a
   platform-specific external reference (e.g. assistant ID, deployment URL).
   The API validates shape, binds the agent to the operator, emits
   `agent.registered`, and returns `agentId`. Chain involvement: none
   required at registration (registration record is off-chain; anchoring
   decisions belong to Phase 4+).
2. **How ownership is established.** Ownership = the authenticated operator
   session that created the registration, later proven per-request by auth
   token and per-chain-action by wallet signature. Transfer requires the
   current operator's signature plus acceptance tracking (Phase 1 detail).
3. **How activity/evidence is submitted.** Evidence arrives as generic
   `Evidence` records: `{ evidenceId, agentId, submittedBy, submittedAt,
category, contentHash, storageRef, content? }`. Large/sensitive content
   stays off-chain with only hashes on record; BOND defines categories
   (transcript, tool-call log, transaction record, human report), never
   provider-shaped payloads. Submission is idempotent via client-supplied
   idempotency keys (doc 10).
4. **How BOND identifies an agent.** By `agentId` internally; externally by
   the triple _(operator, platform label, external reference)_, resolved
   once at registration and then frozen. Re-registration of the same triple
   is rejected as a duplicate (with an explicit appeal/re-register flow).
5. **How risk analysis attaches.** Every `RiskFlag` carries `agentId` +
   `evidenceRefs[]`; flags are queryable per agent and feed the derived
   `riskStatus`. Risk history is append-only.
6. **How external platforms query status.** Via the public verification
   surface (doc 12): registration, eligibility, bond status, reputation,
   enforcement history — no credentials, no private data.
7. **Future SDK.** A thin `packages/sdk/` (recommended, not created) that
   wraps: register, submit-evidence (with hashing + idempotency), and
   status polling. Provider-specific helpers (e.g. "trace a LangGraph run
   into Evidence") live in adapter subpaths, never in core.

BOND never executes the agent. There is no "run agent" endpoint, no sandbox,
and no dependency on any provider runtime.

## 3.3 Agent lifecycle state machine

States (lifecycle of the _registration_, distinct from the _bond_, doc 04):

| State          | Meaning                                                     | Enforced  |
| -------------- | ----------------------------------------------------------- | --------- |
| `UNREGISTERED` | No record (start state, implicit)                           | —         |
| `REGISTERED`   | Record exists, no active bond                               | off-chain |
| `BONDED`       | Active bond attached (see doc 04)                           | both      |
| `ELIGIBLE`     | Bonded + meets policy (incl. ZK eligibility where required) | both      |
| `ACTIVE`       | Eligible + operator-marked in service                       | off-chain |
| `FLAGGED`      | Open risk flag under review (auto on flag, off-chain)       | off-chain |
| `ATTESTED`     | Quorum decision recorded for the flag                       | both      |
| `SLASHED`      | Enforcement executed (follows bond to slashed states)       | both      |
| `SUSPENDED`    | Operator- or policy-paused; no new activity accepted        | off-chain |
| `RESOLVED`     | Flag dismissed or incident closed; returns to prior state   | off-chain |
| `WITHDRAWABLE` | Bond released; registration may persist for history         | both      |

Valid transitions (and who/what causes them):

- `UNREGISTERED → REGISTERED`: operator registers (off-chain).
- `REGISTERED → BONDED`: bond creation confirmed (chain-confirmed, doc 04).
- `BONDED → ELIGIBLE`: policy check passes, incl. ZK proof verification
  where required **[CONTRACT-VERIFY]**.
- `ELIGIBLE → ACTIVE`: operator marks in-service (off-chain).
- `ACTIVE ⇄ FLAGGED`: risk flag opened (auto) / dismissed or resolved.
- `FLAGGED → ATTESTED`: attestor quorum records decision (doc 06).
- `ATTESTED → SLASHED`: enforcement executed on-chain; `ATTESTED → RESOLVED`:
  flag dismissed, no enforcement.
- `SLASHED → RESOLVED`: incident closed after enforcement effects applied.
- Any of `ACTIVE/FLAGGED/RESOLVED → SUSPENDED`: operator pause or policy
  auto-suspend; `SUSPENDED` returns to the state it came from.
- `BONDED/... → WITHDRAWABLE`: bond released per doc 04 lifecycle.

Invalid transitions (must be rejected by API validation and, where mirrored
on-chain, by the contract):

- `UNREGISTERED → *` except `REGISTERED`; `REGISTERED → ELIGIBLE/ACTIVE`
  (bond required first); `FLAGGED → ACTIVE` without resolution/attestation;
  `SLASHED → ACTIVE` without `RESOLVED`; any transition into `ATTESTED`
  without a quorum record; `WITHDRAWABLE → ACTIVE` (requires a new bond).

Analysis note: the candidate list from the brief is _appropriate but
overlapping_ — `ATTESTED` and `SLASHED` are decision/enforcement markers
rather than durable agent states, and `ELIGIBLE` vs `ACTIVE` separates
protocol-readiness from operator intent. Phase 1 must confirm whether
`ATTESTED` persists on the agent or lives only on the flag/decision record;
default recommendation: keep it on the decision record and derive the
agent badge.
