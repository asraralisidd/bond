# 05 — Risk Engine

## 5.1 Role and trust status

The Risk Engine is a **separate, untrusted decision-support component**. It
detects and assesses; it never authorizes, signs, or submits anything
chain-bound. The contract treats Risk Engine output as _claims requiring
attestation_, worth exactly zero enforcement power on its own. A compromised
or malfunctioning Risk Engine can at worst create review workload (false
flags) or miss detections (false negatives) — it cannot move funds.

Pipeline (strict order):

```text
Detection → Risk Assessment → Risk Flag → Attestation → Enforcement
```

Only the last two steps involve attestors/chain; the Risk Engine's job ends
at emitting a well-formed flag.

## 5.2 Stages

1. **Detection.** Evidence (doc 03 §3.2) is normalized into generic
   observations (tool calls, transfers, policy deviations, external
   reports). Provider-specific parsers live in adapters; the core sees only
   normalized observations. Initial risk categories (conceptual, extensible):
   `capability-mismatch`, `unauthorized-action`, `overspend`, `data-exfil`,
   `policy-violation`, `anomalous-behavior`, `external-report`.
2. **Risk Assessment.** Each detection is scored with `severity` (impact
   concept: `low/medium/high/critical`) and `confidence` (0–1 concept with
   model/version recorded). Scoring functions and thresholds are versioned
   configuration, not code constants — Phase 2 must make `model/version` a
   first-class input so flags are reproducible and auditable.
3. **Risk Flag.** Emission of a `RiskFlag` record (below) and the
   `ACTIVE → FLAGGED` agent transition. Emission is idempotent per
   detection batch (duplicate evidence resubmission must not duplicate
   flags; content-hash + batch-key dedupe concept).
4. **Handoff.** The flag — with evidence references, never raw chain power —
   is published to the Attestor System queue. The engine takes no further
   action on the flag except recording assessment revisions as new versions.

## 5.3 Conceptual RiskFlag

Concept inventory (not a table yet): `riskFlagId`, `agentId`, `category`,
`severity`, `confidence`, `evidenceRefs[]` (hashes/pointers, §8 privacy
rules), `timestamp`, `model/version` (scorer identity + config version),
`status` (`open → under-review → attested | dismissed | expired`), and
`supersedes` linkage for revised assessments.

## 5.4 Non-requirements (explicit)

- No transaction signing, no key custody, no chain reads beyond public
  mirror data.
- No autonomous enforcement, no auto-slash, no auto-withdraw — even at
  `critical` severity. The strongest automatic action is opening a flag and
  requesting expedited attestation.
- No provider-specific logic in scoring core; provider quirks are adapter
  normalization concerns.
