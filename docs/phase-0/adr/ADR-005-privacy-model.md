# ADR-005 — Privacy model (gatewayed disclosure)

- **Status:** Accepted (Phase 0).
- **Context:** BOND must prove compliance publicly while hiding amounts,
  evidence, witnesses, and secrets.
- **Decision:** Explicit PRIVATE vs PUBLIC/VERIFIABLE split (doc 08) with
  gatewayed disclosure: data goes public only via attested decisions, ZK
  verifications, or policy publications — each recorded. ZK scope starts at
  eligibility proofs only.
- **Consequences:** Public serializers must be incapable of representing
  private fields (Phase 1 acceptance); attestor access is itself
  privacy-gated; ZK work is bounded and shippable.
- **Verification:** Proof system and Compact specifics are
  **[VERIFY-MIDNIGHT]**.
