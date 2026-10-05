# 06 — Attestor System

## 6.1 Purpose

Attestation converts an _untrusted risk flag_ into a _verified enforcement
decision_ the contract may execute. The contract must never trust a single
AI model — nor a single attestor. Design below is conceptual; cryptographic
mechanisms (signature schemes, on-chain verification) are
**[VERIFY-MIDNIGHT]**.

## 6.2 Concepts

- **Attestor identity.** Each attestor is a registered entity with a stable
  `attestorId`, a verification key, declared independence (operator,
  organization, jurisdiction concept), and a status (`active/suspended/
retired`). Registration and key rotation are auditable events. Initial
  operation may use operator-run attestors, but the model must support
  mutually independent parties — otherwise "independent attestation" is
  fiction (see residual risks, doc 13).
- **Attestation request.** `{ requestId, riskFlagId, agentId, evidenceRefs[],
policyVersion, requestedAt, expiresAt }`. Requests expire: stale flags
  cannot be enforced late.
- **Evidence reference.** Attestors review the same referenced evidence as
  the flag (hashes + authorized access), never private raw data they are
  not entitled to (doc 08 boundary applies to attestors too).
- **Attestation result.** Per-attestor verdict concept: `confirm |
reject | abstain`, with severity recommendation, rationale reference, and
  timestamp. Individual verdicts are recorded even when they lose the vote.
- **Signature / proof concept.** Each verdict is cryptographically bound to
  (requestId, flagId, verdict, expiry). Exact scheme is
  **[VERIFY-MIDNIGHT]**; the requirement is non-repudiation + on-chain
  verifiability, not any particular algorithm.
- **Expiration.** Requests and verdicts carry expiries; enforcement calls
  with expired material must fail on-chain **[CONTRACT-VERIFY]**.
- **Replay prevention.** Every enforcement decision carries a unique
  decision id + nullifier concept consumed on execution, so the same quorum
  cannot slash twice (see doc 08).
- **Duplicate prevention.** Idempotency keys on requests; content-hash
  dedupe so one flag yields at most one decision lifecycle (superseded only
  by explicit re-review with a new request id linked to the old).
- **Multiple attestors & threshold.** Initial concept: **2-of-3**. The
  threshold is configurable policy, not a constant — stored with
  `policyVersion`, changeable only out-of-band from any open decision.
  Rationale for 2-of-3 initially: tolerates one faulty/malicious attestor
  while remaining operable for a small network; larger sets use the same
  mechanism with higher thresholds.

## 6.3 Decision flow

```text
RiskFlag(open) → attestation request (expiry set)
  → attestors fetch evidence → verdicts signed (confirm/reject/abstain)
  → threshold met? → enforcement decision { decisionId, action, amount,
      nullifier, expiry } → Midnight Adapter → contract executes
      (threshold + expiry + nullifier checks on-chain)
```

Rejection path: threshold of rejects (or expiry without quorum) moves the
flag to `dismissed/expired` and unlocks any review-lock, with full rationale
retained. Abstentions count toward neither side but are recorded.

## 6.4 What the contract checks (on-chain, [CONTRACT-VERIFY])

1. Quorum: ≥ threshold valid signatures from currently-active attestors.
2. Freshness: decision and all verdicts unexpired at execution time.
3. Binding: decision references the exact flag + policy version.
4. Single-use: decision nullifier unconsumed; consume on success.
5. Authority scope: action ∈ {partial-slash, full-slash, dismiss} within
   bonded amount; nothing else callable via this path.
