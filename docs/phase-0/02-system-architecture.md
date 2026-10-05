# 02 — System architecture

## 2.1 Layered architecture

```text
External agent platform (OpenAI / Claude / Gemini / LangChain / CrewAI / custom)
        ↓
BOND SDK / Adapter (provider-specific, outside the core protocol)
        ↓
BOND API (`apps/api`, versioned `/api/v1/*`)
        ↓
Agent Registry (off-chain record + identity; source of truth for metadata)
        ↓
Risk Engine (`packages/risk-engine`: detection → assessment → flag; advisory only)
        ↓
Attestor System (`packages/attestor`: independent verification + threshold signing)
        ↓
Midnight Adapter (`packages/midnight-adapter`: sole chain-facing seam)
        ↓
Compact Contract / Midnight (`contracts/`: enforcement, nullifiers, tx state)
```

Layer rules (binding):

1. **Each layer only talks to its neighbors.** The web app never touches the
   adapter directly; the Risk Engine never touches the contract.
2. **Trust decreases downward.** Upper layers may be compromised without
   granting chain authority: the contract accepts only attested decisions
   that satisfy its on-chain policy (threshold, expiry, nullifiers).
3. **The Midnight Adapter is the only module allowed to construct or submit
   chain transactions.** No other package imports wallet, proving, or
   transaction APIs. **[VERIFY-MIDNIGHT]**: exact SDK surface to be confirmed
   from official docs at implementation time.
4. **Do not assume Ethereum/MetaMask architecture.** Account models,
   signing flows, and confirmation semantics are Midnight-specific and
   currently unverified — the frontend flow (doc 11) is designed around
   explicit states so it survives whatever the real flow is.

## 2.2 Security boundary (conceptual flow)

```text
Evidence → Risk Engine → Risk Flag → Attestor System
    → Verified Enforcement Decision → Midnight Adapter → Contract
```

- The **Risk Engine** is _decision support_: it produces `RiskFlag`s with
  severity/confidence, but a flag alone moves no funds and changes no
  on-chain state.
- An **Attestor System** quorum independently checks the flag against
  referenced evidence and co-signs an enforcement decision (threshold-gated).
- The **Contract** enforces: threshold validity, expiry, replay protection
  (nullifiers), and idempotent state transitions. It trusts cryptography
  and its own stored policy — not any single off-chain component.

See docs 05 and 06 for component detail.

## 2.3 Operator model (initial)

```text
Operator → Midnight Wallet → Register Agent → Create Bond → Manage Agent
```

- The **operator** (human or service account) holds the Midnight wallet and
  pays for / authorizes all chain interactions.
- The **AI agent itself has no wallet** in the initial architecture. This
  removes an entire class of key-management risk (agent-held signing
  material) and matches the principle that BOND observes agents rather than
  running them.
- Consequence: every on-chain action is attributable to an operator, and
  "agent identity" is always a registered claim _(operator X asserts agent
  Y)_ rather than a self-sovereign agent key. Agent key material may be
  introduced later for evidence signing only — never for fund movement —
  and only via a dedicated ADR.

## 2.4 Midnight layering (five distinct concerns)

| Concern                 | Owner              | Notes                                                        |
| ----------------------- | ------------------ | ------------------------------------------------------------ |
| Frontend wallet connect | `apps/web`         | Explicit tx states (doc 11); no success before confirmation  |
| Backend                 | `apps/api`         | Builds unsigned intent, tracks tx records, never holds keys  |
| Midnight adapter        | `midnight-adapter` | Sole seam for proofs/tx submission **[VERIFY-MIDNIGHT]**     |
| Contract                | `contracts/`       | Policy, nullifiers, state machine **[VERIFY-MIDNIGHT]**      |
| Chain tx state          | Midnight network   | `pending → submitted → confirmed/failed`; backend mirrors it |

Key management rule: **signing material lives only in the operator's wallet
(frontend side) and, for attestors, in attestor-held keys.** The backend and
adapter never persist private keys or seed material.

## 2.5 Repository architecture evaluation

Current foundation (`apps/`, `packages/`, `contracts/`, `database/`,
`tests/`, `docs/`, `infra/`) is **retained as-is**. Assessment per area:

- `apps/web`, `apps/api` — correct homes for frontend and backend; no change.
- `packages/shared-types` — will hold versioned DTO concepts from Phase 1 on;
  keep transport types separate from domain concepts.
- `packages/risk-engine`, `packages/attestor`, `packages/midnight-adapter` —
  boundaries already match §2.1 layer rules. Keep the "single chain-facing
  seam" rule for the adapter.
- `contracts/` — reserve for Compact sources + generated bindings later; add
  `contracts/README` policy (no fake contracts) — already present.
- `database/` — will gain a migration tool + versioned migrations in Phase 7,
  not Phase 1 (spec first). No change now.
- `tests/` — later: mirror `tests/{unit,integration,e2e}` conceptually; no
  restructuring needed yet.
- **Recommended additions (documentation-only for now, implement in Phase 1):**
  1. `packages/sdk/` — future platform-agnostic integration SDK (doc 03 §3.7).
     Recommend, do not create yet.
  2. `packages/policy/` or a policy concept inside shared domain — slashing
     policy versioning must live somewhere explicit; decide in Phase 1.
  3. `database/migrations/` + `database/seeds/` layout — decide with the
     migration-tool choice in Phase 7; do not pre-create.

No other restructuring is warranted. The monorepo stays lightweight: no new
services, no new infrastructure components (see ADR-007).
