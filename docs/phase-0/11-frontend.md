# 11 — Frontend concept

## 11.1 Screens (conceptual, no implementation)

- **Dashboard** — operator's agents at a glance: counts by status, open
  flags, pending txs, recent protocol events.
- **Agents** — filterable registry (status, platform, reputation band).
- **Agent Details** — full picture: metadata, bond state, risk status,
  flags, attestations, slashes, reputation history, tx records.
- **Register Agent** — guided form (platform, type, capabilities, external
  ref) with duplicate-triple warning before submit.
- **Bond** — create/fund/release/withdraw flows with policy-version display.
- **Eligibility** — check view + ZK proof submission entry (opaque artifact
  handoff; proving happens client-side per doc 08).
- **Risk Analysis** — flag list + flag detail (evidence refs, severity,
  confidence, model/version, assessment history).
- **Attestations** — decision status per flag; attestor verdicts as they
  become visible to the operator.
- **Slash Events** — immutable enforcement records with decision + tx refs.
- **Public Verification** — doc 12 view, visually distinguished as
  "public-safe" (no private data reachable from this screen).

## 11.2 Chain-operation state machine (binding on implementation)

```text
idle → wallet-approval → pending → submitted → confirmed
                                              ↘ failed
```

Rules:

1. Every chain action (register-anchoring where applicable, fund, slash is
   **not** operator-triggered, release, withdraw) renders its exact state;
   polling/reconciliation against `transaction_records` (doc 09) drives it.
2. **Never represent an unconfirmed transaction as successful.** `pending`
   and `submitted` are visibly provisional; only `confirmed` unlocks
   successor actions.
3. `failed` shows reason class (rejected in wallet / on-chain failure /
   expired) + safe retry path using the same idempotency key (no duplicate
   submissions).
4. `wallet-approval` explicitly indicates control has left the app (user
   acts in wallet); the app waits, it does not assume. Exact wallet UX is
   **[VERIFY-MIDNIGHT]** — the state machine above is designed to fit any
   wallet flow.
5. Stale-state guard: if chain state disagrees with the displayed state on
   refresh, show a reconciliation notice (chain wins) and log an incident.

## 11.3 State handling

- Server state (agents, bonds, flags, txs) is read from `/api/v1` with
  request correlation (doc 14); chain-affecting mutations are disabled
  while a predecessor tx is unconfirmed.
- Wallet/adaptor state is isolated from domain state: wallet disconnect
  mid-flow returns the flow to `idle` with intent preserved as a draft,
  never as a submission.
