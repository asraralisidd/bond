# 07 — Reputation model

## 7.1 Principles

- Reputation is **derived history, not an asset**. No token, no transfer, no
  market, no staking-for-score. It cannot be bought, sold, or delegated —
  only earned through behavior and lost through violations.
- It is computed from the append-only record (registrations, flags,
  attestations, slashes, resolutions), never self-asserted by the operator.
- It is **public by default at summary level** (doc 12) and private at
  detail level (doc 08): anyone may see the score band and counts; only
  entitled parties see underlying evidence.

## 7.2 Inputs

- **Positive history.** Sustained bonded-active periods without flags,
  completed bonds withdrawn cleanly, resolved incidents with remediation.
  Weight recency: recent clean operation counts more than ancient history
  (exact decay function is Phase 2+ design, not fixed here).
- **Violations.** Confirmed flags by category/severity (unconfirmed or
  dismissed flags must not depress reputation — accusation is not guilt).
- **Slashes.** Partial vs full, with amounts/bands public (counts and bands,
  not exact private figures where privacy policy says otherwise — doc 08).
- **Resolved incidents.** Closure with remediation _partially restores_
  standing: the slash stays on record permanently, but a `rehabilitated`
  marker improves the summary faster than silent ageing.

## 7.3 Updates

- Reputation updates are **event-sourced**: every change references the
  triggering event (`slash_event`, `resolution`, clean-period checkpoint).
- Recomputation must be deterministic from history (replayable). No manual
  score edits; corrections happen via new events (e.g. overturned decision),
  never by rewriting the past.
- Reputation never gates fund movement by itself — it informs policy
  (e.g. minimum bond per reputation band, a Phase 1+ policy decision) and
  informs verifiers.

## 7.4 Public vs private

| Public (summary)                              | Private (detail, entitled only)        |
| --------------------------------------------- | -------------------------------------- |
| Score band / tier (not raw internals)         | Full event narratives                  |
| Counts: flags confirmed, slashes, resolutions | Raw evidence content                   |
| Current standing (`good / probation / poor`)  | Risk model internals, attestor notes   |
| Enforcement history (action + date + band)    | Exact private amounts where applicable |

## 7.5 Explicit non-goals

No token-based reputation, no tradable scores, no cross-protocol reputation
import in the initial build (unverifiable inputs would poison the model).
