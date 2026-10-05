# ADR-003 — AI/Risk → Attestor → Contract boundary

- **Status:** Accepted (Phase 0).
- **Context:** An AI scorer must never move funds; a single model must never
  be the sole authority for slashing.
- **Decision:** Strict pipeline Evidence → Risk Engine (advisory flags) →
  Attestor quorum (verified decisions) → Contract (enforcement). The Risk
  Engine is untrusted from the chain's perspective; the contract enforces
  quorum, freshness, scope, and single-use on every decision.
- **Consequences:** Extra latency and attestor operating cost per
  enforcement; false flags are cheap, false enforcement is structurally
  hard. Threshold is configurable policy (2-of-3 initial concept).
- **Verification:** On-chain check semantics are **[CONTRACT-VERIFY]**.
