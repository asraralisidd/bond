# ADR-006 — PostgreSQL as the system of record (off-chain)

- **Status:** Accepted (Phase 0).
- **Context:** BOND needs durable, relational, auditable off-chain state
  (registrations, flags, decisions, mirrors of chain state) operable on an
  8 GB RAM laptop.
- **Decision:** PostgreSQL (already in foundation compose) is the off-chain
  store. Conceptual entities in doc 09; migration tooling + schema land in
  later phases, not Phase 0/1. The chain remains authoritative for funds;
  Postgres rows are reconciled caches with receipts.
- **Consequences:** Single proven store, trivial local ops; must design the
  chain-reconciliation protocol (open item, doc 09 §9.3) before withdrawals
  go live.
- **Verification:** No external API risk; pgcrypto extension already staged.
