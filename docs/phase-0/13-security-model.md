# 13 — Security model

Format per threat: Threat / Attack surface / Impact / Mitigation / Residual risk.

## 13.1 Identity & credential threats

1. **Forged agent identity.**
   Surface: registration inputs, external refs. Impact: bond attached to a
   fake; enforcement misses the real agent. Mitigation: operator-bound
   registration, duplicate-triple rejection, evidence cross-checks at flag
   time. Residual: determined impersonation with operator collusion —
   converges with malicious-operator case.
2. **Stolen operator credentials.**
   Surface: session tokens, wallet device. Impact: full account takeover:
   rogue registration, fund movement. Mitigation: session hygiene, separate
   wallet approval for chain actions (two-factor by construction: session +
   wallet), revocation + incident flow. Residual: device compromise; wallet-
   signature login hardening (Phase 10).
3. **Malicious operator.**
   Surface: self-bonded agents, self-submitted evidence. Impact: gaming
   reputation, griefing via false reports against others. Mitigation:
   evidence required for flags (no self-attested outcomes), dismissal
   without penalty to the accused, rate limits + abuse detection.
   Residual: sophisticated long-game reputation farming; decay + bands
   limit the payoff.

## 13.2 Agent & evidence threats

4. **Malicious agent.**
   Surface: agent actions in the external platform. Impact: the core insured
   event (harm to third parties). Mitigation: the entire pipeline —
   detection, flags, attestation, slashing, reputation. Residual: harm
   exceeding bonded value (bond sizing is policy, not security).
5. **Manipulated evidence.**
   Surface: evidence submission path. Impact: false flags or suppressed
   detection. Mitigation: content-hash integrity, multi-source corroboration
   concept, attestor review of evidence (not of scores), append-only
   history. Residual: coordinated multi-source fabrication; attestor
   independence is the backstop.

## 13.3 Risk/attestor threats

6. **Malicious Risk Engine (or compromised scorer).**
   Surface: scoring code/config. Impact: flag floods or blind spots.
   Mitigation: engine has zero chain authority (§2.2); versioned
   model/config; dismissal path costless. Residual: missed detections —
   covered by external reporting channel (doc 05 category).
7. **Forged attestation.**
   Surface: verdict submission, key handling. Impact: unauthorized
   enforcement. Mitigation: per-verdict signatures bound to request+expiry,
   on-chain quorum + freshness + scope checks (doc 06 §6.4). Residual:
   cryptographic break of the chosen scheme — scheme agility required at
   implementation **[VERIFY-MIDNIGHT]**.
8. **Colluding attestors (≥ threshold).**
   Surface: attestor set. Impact: arbitrary enforcement within bonded
   amounts. Mitigation: independence requirements for attestor admission,
   transparent verdict records, configurable threshold raised as the set
   grows, anomaly detection on voting patterns. Residual: fundamental to
   any quorum system; threshold + independence is the control, not a cure.

## 13.4 Replay & duplication threats

9. **Replay attacks (proofs, attestations, txs).**
   Surface: any submitted artifact. Mitigation: nullifiers consumed on-chain
   - backend idempotency dedupe (doc 08 §8.3). Residual: mechanism
     correctness depends on **[VERIFY-MIDNIGHT]** primitives.
10. **Duplicate submissions (slash/withdrawal).**
    Surface: retry paths, double-clicks, concurrent sessions. Mitigation:
    single-issuance decisions, one active bond per agent, same-key retries
    return prior result. Residual: UX-level confusion only; chain state is
    the arbiter.

## 13.5 Authorization threats

11. **Unauthorized slashing.**
    Surface: any API/contract entry. Mitigation: no mutating slash endpoint
    exists (doc 10); contract executes only quorum-bound, scoped, fresh,
    unused decisions. Residual: quorum collusion (threat 8).
12. **Unauthorized withdrawal.**
    Surface: release/withdraw paths. Mitigation: contract-gated release
    conditions + withdrawal nullifiers **[CONTRACT-VERIFY]**; backend
    intent requires owning operator. Residual: policy bug releasing early —
    policy versioning + review is the control.
13. **Race conditions (flag vs release, lock vs withdraw).**
    Surface: concurrent transitions. Mitigation: lock states block release
    (doc 04), decision binding to policy version + flag snapshot, contract
    as serialization point. Residual: UX races showing transient states —
    reconciliation notices (doc 11).

## 13.6 Platform threats

14. **Stale transaction state.**
    Surface: mirrors, caches, polling. Impact: acting on outdated state
    (e.g. withdrawing against a slashed bond). Mitigation: chain-wins
    reconciliation, `asOf` labelling, successor actions gated on
    `confirmed`. Residual: brief windows between confirmation and mirror
    update — bounded by poll interval, visible to users.
15. **API abuse (enumeration, scraping, DoS).**
    Surface: public + authenticated routes. Mitigation: rate limits,
    cursor pagination without oracles (doc 12 §12.3), auth separation
    (operator vs attestor), lightweight abuse detection (no heavy SIEM in
    initial build). Residual: determined scraping of public data — accepted;
    public data is public.
16. **Privacy leakage (evidence/amounts/keys via logs, errors, responses).**
    Surface: every layer. Mitigation: privacy boundary + gateways (doc 08),
    separate public serializers, no private data in logs/errors (request
    IDs instead), secrets never leave custody domains. Residual: operational
    error; review checklist + tests in Phase 11 must cover serializers and
    log output explicitly.
