# 09 — Conceptual data model (no schema)

> No migrations, no columns, no SQL. Entities and relationships only. Every
> "concept list" below is an inventory for Phase 1 modeling, not a table
> definition.

## 9.1 Entities

- **operators** — the accountable party. Concepts: operator id, auth
  identity, wallet binding(s), status. One operator owns many agents.
- **agents** — the registered claim (doc 03 §3.1). Belongs to one operator;
  has at most one active bond; accumulates flags, attestations (via flags),
  slashes, reputation records.
- **bonds** — collateral lifecycle per agent (doc 04). Belongs to one agent
  (+ operator); produces slash events; ends in withdrawal or full slash.
- **risk_flags** — advisory findings (doc 05 §5.3). Belong to one agent;
  reference evidence; spawn at most one attestation request lifecycle.
- **attestations** — quorum decisions (doc 06). Belong to one flag; composed
  of member verdicts; yield at most one enforcement decision.
- **slash_events** — executed enforcements. Belong to one bond (+ decision);
  immutable once confirmed; feed reputation.
- **reputation_records** — event-sourced standing entries (doc 07). Belong
  to one agent; each references its triggering event; replayable.
- **protocol_events** — append-only audit log of every state transition
  across all entities (who/what caused it, when, under which policy).
- **transaction_records** — chain-tx mirrors: intent, submissions, status
  (`pending/submitted/confirmed/failed`), chain refs, nullifiers consumed.
  The chain is authoritative; these records are reconciled caches (doc 04
  §4.4, doc 14).

Supporting concepts (not necessarily entities): evidence descriptors
(content hashes + storage refs, privacy-gated per doc 08), idempotency keys
(request-scoped dedupe), policy versions (slashing/threshold parameters).

## 9.2 Relationships (summary)

```text
operator 1──* agents 1──* bonds 1──* slash_events
              │         └──(≤1 active bond)
              ├──* risk_flags 1──(≤1) attestation-request──* verdicts──(≤1) decision
              ├──* reputation_records (each → triggering event)
              └──* transaction_records (each → chain tx, nullable until submitted)
all entities *──* protocol_events (audit spine)
```

Cardinality rules with teeth: one active bond per agent; one decision
lifecycle per flag (re-review links forward, never rewrites); slash events
immutable; reputation derived, never edited.

## 9.3 What Phase 1 must decide (left open deliberately)

- Whether evidence descriptors are a first-class entity or a JSON concept
  on flags (privacy-access patterns decide this).
- Whether attestor identities/keys live in this database at all or in a
  separate trust store (security review decides).
- Exact reconciliation protocol between `transaction_records` and chain
  state (needs **[VERIFY-MIDNIGHT]** tx lifecycle semantics first).
