# ADR-002 — Operator-wallet model (no agent wallets initially)

- **Status:** Accepted (Phase 0).
- **Context:** Giving AI agents their own wallets would require agents to
  hold signing material — high risk, unclear benefit for v1.
- **Decision:** Only the operator holds a Midnight wallet and authorizes all
  chain actions (register → bond → manage). Agent identity is a registered
  operator claim, not a self-sovereign key.
- **Consequences:** Simpler key management; every on-chain action is
  attributable; agents cannot transact autonomously. Evidence-signing keys
  for agents may be added later (authenticity only, never funds) via a new
  ADR.
- **Verification:** Wallet UX/flow details are **[VERIFY-MIDNIGHT]**.
