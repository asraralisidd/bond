# 12 — Public verification

## 12.1 Purpose

Let any third party answer "can I trust this agent?" without credentials
and without accessing anything private. Verification is read-only,
rate-limited, and served by dedicated public serializers (doc 10) that
cannot represent private fields.

## 12.2 Conceptual query → result

```text
Agent ID → registration status → eligibility → bond status → reputation
  → enforcement history → verification result (trusted / caution / untrusted)
```

- **Inputs:** `agentId` only (plus optional `policyVersion` pin for
  reproducibility of the verdict).
- **Outputs (public-safe):** registration + active/inactive, eligibility
  boolean + policy version, bond status band (e.g. bonded/released/slashed —
  exact amounts only if policy says public), reputation band + counts,
  enforcement history (action, date, band), and a computed verification
  result with the rules version that produced it.
- **Never exposed:** private evidence, witnesses, exact private amounts,
  model internals, attestor notes, operator PII, signing material.

## 12.3 Guarantees and limits

- **Soundness over completeness:** the endpoint reports what is verifiable
  from attested/chain-confirmed records; absence of a flag is reported as
  "no confirmed findings", never as "proven safe".
- **Freshness labelling:** every result carries `asOf` (chain height /
  timestamp concept) so verifiers can judge staleness.
- **Abuse resistance:** rate limits + response caching; no query path may
  enumerate private data by probing (banded outputs, no error oracles —
  unknown IDs and hidden states are indistinguishable in shape).
- **Auditability:** verification results are reproducible from public
  records + published policy versions; disputes reference `requestId`s
  (doc 14).
