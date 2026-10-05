# 08 — Privacy model, ZK eligibility & nullifiers

## 8.1 Privacy boundary (explicit)

**PRIVATE** (need-to-know only; never on public surfaces, never in
unencrypted logs):

- Private bond information where applicable (exact amounts, funding sources).
- Private evidence and witnesses (raw transcripts, tool logs, reporter
  identity where protection applies).
- Sensitive scoring inputs and model internals.
- Cryptographic secrets and signing material (operator wallet keys,
  attestor keys). These never leave their custody domain (§2.4 key rule).

**PUBLIC / VERIFIABLE:**

- Agent registration status, eligibility status, active/inactive status.
- Reputation summaries per doc 07 §7.4.
- Slash counts/status bands and protocol events.
- Transaction status (submitted/confirmed/failed + public refs).

**Boundary rule:** data crosses from private to public only through a
defined gateway — an attested decision, a ZK verification, or an explicit
policy publication — each recorded with what was revealed, to whom, and
under which policy version. Anything not through a gateway stays private.

## 8.2 ZK eligibility (conceptual architecture only)

```text
Private Inputs → Witness → ZK Proof → Public Statement → Verification
```

- **Private inputs:** bond amount/commitment, operator identity material,
  evidence details — whatever the eligibility policy requires but must not
  reveal.
- **Witness:** the full private pre-image assembled client-side (operator
  frontend or adapter), never sent to the backend in the clear.
- **ZK proof:** generated client-side against the eligibility circuit for
  the active policy version. No algorithm or Compact syntax is assumed or
  specified here — **[VERIFY-MIDNIGHT]**.
- **Public statement:** e.g. "agent X meets bond policy vN" (boolean +
  policy version + scope), consumable by the contract and public verifiers.
- **Verification:** on-chain where it gates state (eligibility, enforcement
  preconditions) **[CONTRACT-VERIFY]**; off-chain mirrors for display.

What an operator should be able to prove (without over-exposure):

1. Collateral sufficiency ("locked ≥ required") without revealing the exact
   amount or funding source.
2. Policy compliance ("bond under current policy vN") without revealing
   negotiation history.
3. Clean-standing ("no unresolved enforcement") without revealing dismissed
   flags or private evidence.

Non-goals: proving arbitrary agent-behavior claims in ZK in the initial
build; ZK for reputation internals. Start with eligibility only.

## 8.3 Nullifiers & replay protection (conceptual)

Requirement: the following must be single-use / duplicate-safe without
relying on any unverified Midnight API — the _concept_ is specified here,
the mechanism is **[VERIFY-MIDNIGHT]** at implementation:

- Replayed proofs (same eligibility proof submitted twice).
- Replayed attestations (same verdict set executed twice).
- Duplicate slash requests (same decision enforced twice).
- Duplicate withdrawal requests (same release withdrawn twice).
- Repeated enforcement (re-executing a consumed decision).

Conceptual mechanism: every enforceable artifact carries a unique nullifier;
the contract stores consumed nullifiers and rejects reuse; the backend
additionally dedupes by idempotency key before submission so users get
clean "already done" responses instead of failed transactions. Backend
dedupe is UX; **contract nullifiers are the security control**.
