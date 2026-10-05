# ADR-004 — Midnight adapter as the sole chain-facing seam

- **Status:** Accepted (Phase 0).
- **Context:** Chain SDKs change; wallet/proving/tx APIs are currently
  unverified. Scattering chain calls across the codebase would make every
  SDK change a system-wide change.
- **Decision:** `packages/midnight-adapter` is the only module allowed to
  construct proofs, touch wallet APIs, or submit transactions. All other
  code treats the chain through this seam. No Ethereum/MetaMask assumptions
  anywhere.
- **Consequences:** Chain upgrades are contained; the adapter becomes a
  critical review focus; everything behind it stays testable without a
  chain.
- **Verification:** Entire adapter surface is **[VERIFY-MIDNIGHT]** —
  no API invented in Phase 0.
