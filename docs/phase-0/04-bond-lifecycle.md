# 04 — Bond lifecycle

## 4.1 Concept

A **Bond** is collateral locked against a specific agent under a versioned
slashing policy. One agent has at most one _active_ bond at a time; history
is append-only. Concept inventory (not schema): `bondId`, `agentId`,
`operatorId`, `amount/commitment`, `policyVersion`, `state`, timestamps,
`slashEvents[]`, `release/withdrawal refs`, chain `txRefs[]`.

## 4.2 States

| State               | Meaning                                                                     | Enforced  |
| ------------------- | --------------------------------------------------------------------------- | --------- |
| `CREATED`           | Intent recorded off-chain (creation)                                        | off-chain |
| `PENDING`           | Funding tx submitted, not yet confirmed                                     | both      |
| `ACTIVE`            | Collateral confirmed locked under policy                                    | on-chain  |
| `LOCKED`            | Locked + temporarily non-withdrawable (cooldown, open flag, dispute window) | on-chain  |
| `PARTIALLY_SLASHED` | One or more partial enforcements applied; remainder locked                  | on-chain  |
| `FULLY_SLASHED`     | Entire collateral consumed by enforcement                                   | on-chain  |
| `WITHDRAWABLE`      | Released by policy; awaiting operator withdrawal                            | on-chain  |
| `WITHDRAWN`         | Funds returned to operator (terminal)                                       | on-chain  |
| `FAILED`            | Funding never confirmed / creation aborted (terminal)                       | off-chain |
| `CANCELLED`         | Operator-cancelled before activation (terminal)                             | both      |

## 4.3 Transitions

- `CREATED → PENDING`: operator submits funding tx (wallet approval, doc 11
  states apply; never show as funded before confirmation).
- `PENDING → ACTIVE`: funding confirmed on-chain; `PENDING → FAILED`: timeout
  / tx failed. Confirmation source is chain state mirrored into `txRefs[]`,
  never frontend optimism.
- `ACTIVE ⇄ LOCKED`: lock on flag-open / dispute / cooldown start; unlock
  when the reason clears. `LOCKED` blocks withdrawal and new slashing-policy
  changes but not enforcement of already-attested decisions.
- `ACTIVE/LOCKED → PARTIALLY_SLASHED`: attested enforcement consumes part of
  collateral (each slash is a separate `slash_event` with decision ref).
- `… → FULLY_SLASHED`: collateral exhausted; agent follows to `SLASHED`.
- `ACTIVE/PARTIALLY_SLASHED → WITHDRAWABLE`: policy release conditions met
  (expiry, clean record, cooldown elapsed) — release itself is an
  attested-or-policy-automatic on-chain transition **[CONTRACT-VERIFY]**.
- `WITHDRAWABLE → WITHDRAWN`: operator withdrawal tx confirmed. Nullifier /
  idempotency concept required so withdrawal cannot execute twice (doc 08).
- `CREATED → CANCELLED`: operator cancels before funding confirms.

Invalid: `PENDING → WITHDRAWABLE`, `FAILED → *` (except re-create as a new
bond), `WITHDRAWN → *`, slashing from `WITHDRAWABLE` for pre-release conduct
unless policy explicitly extends liability (Phase 1 decision), changing
`policyVersion` mid-`ACTIVE` (requires close + re-bond).

## 4.4 Off-chain vs contract-enforced

- **Off-chain (backend):** `CREATED`, intent tracking, policy evaluation
  inputs, notifications, history views.
- **On-chain (contract) [CONTRACT-VERIFY]:** lock accounting, slash
  deductions, release/withdrawal gating, nullifiers, threshold checks on
  enforcement calls.
- **Mirrored (backend tracks, chain decides):** `PENDING/ACTIVE/…/WITHDRAWN`
  as `txRefs[]` + `protocol_events`. The backend is a _cache with receipts_,
  reconciled against chain state; on divergence, chain wins and an incident
  is raised (doc 14).
