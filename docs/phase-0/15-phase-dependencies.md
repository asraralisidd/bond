# 15 — Phase dependencies, out-of-scope & Phase 1 acceptance

## 15.1 Dependency order assessment

The proposed order (Phases 1–15) is **accepted with two corrections**:

1. **Phase 13 (Docker/local env) moves earlier in practice, not later.**
   The foundation already provides Postgres/compose scaffolding, and each
   phase needs a runnable environment. Treat local-env work as continuous
   (extend per phase) rather than a Phase 13 surprise. No phase renumbering
   required — interpret 13 as "production-grade hardening of the env", with
   day-to-day env support ongoing from now.
2. **Phase 12 (Observability) must start at Phase 1, not wait.**
   Correlation IDs, `protocol_events`, and audit-trail conventions are
   cheapest when adopted with the domain model. Interpret 12 as "mature and
   alert on top", with ID/event conventions landing in Phase 1.

Corrected dependency map:

```text
Phase 0 (this spec)
  → Phase 1 Domain Model (concepts → versioned TS types + OpenAPI sketches; IDs/events conventions land here)
    → Phase 2 Risk Engine ──┐
    → Phase 3 Attestor ──────┴→ Phase 4 Compact Contract (needs both flag + decision shapes)
      → Phase 5 Midnight Integration (needs contract + adapter seam defined)
        → Phase 6 ZK Eligibility (needs chain + proof-surface reality)
    → Phase 7 Backend + PostgreSQL (can start after Phase 1; needs 2–6 contracts to finish endpoints)
      → Phase 8 Dashboard (needs 7 + 5 tx semantics)
        → Phase 9 Public Verification (needs 7 + 8 privacy boundary proven)
  → Phase 10 Security Hardening (after 5,7,8 real code exists to harden)
  → Phase 11 Testing (continuous from Phase 1; dedicated pass after 10)
  → Phase 12 Observability (conventions in Phase 1; alerting/maturity here)
  → Phase 13 Docker/local env (continuous; production-grade here)
  → Phase 14 CI/CD (after builds/tests stable, ~Phase 7+)
  → Phase 15 Documentation (continuous; consolidation here)
```

Why this order: nothing chain-facing (4–6) can be built before the
off-chain decision shapes (1–3) exist; nothing user-facing (8–9) before the
backend and tx semantics (5, 7) are real; hardening/testing (10–11) need
real code to bite into.

## 15.2 Out of scope for initial build (binding)

Kubernetes, Kafka, Elasticsearch, service mesh, multi-region deployment,
cross-chain support, DAO governance, MPC, HSM infrastructure, automatic
agent wallet creation, unnecessary Redis, unnecessary microservices. Any of
these requires a demonstrated requirement + new ADR before adoption.

## 15.3 Phase 1 acceptance criteria

Phase 1 (Domain Model) is done — and implementation may begin — **iff all**
of the following hold:

1. **Ubiquitous language frozen:** agent, bond, evidence, risk flag,
   attestation, decision, slash event, reputation record, protocol event,
   transaction record mean exactly one thing each; doc 03/04/09 updated to
   match.
2. **State machines locked:** agent (§3.3) and bond (§4.2/4.3) states,
   transitions, actors, and off-chain/on-chain labels agreed; invalid
   transitions enumerated; the `ATTESTED`-on-agent question resolved.
3. **Concept inventories versioned:** field-concept lists for RiskFlag,
   decision, bond, and agent exist under a `v0` tag with a stated
   evolution policy (additive-only within major).
4. **Privacy gateway list complete:** every private→public crossing named
   with its gateway (attestation / ZK verification / policy publication).
5. **API surface sketched:** OpenAPI sketches for all §10 areas with
   auth/authz + idempotency per route; separate public serializers named.
6. **ID/event conventions adopted:** §14 IDs on all concepts; `protocol_
event` emission points listed per transition.
7. **Open questions triaged:** every §15.4-class question either answered
   or explicitly deferred to a named later phase with an owner.
8. **No implementation started:** no tables, no endpoints, no contract
   code — the foundation shells still throw `not-implemented`.

## 15.4 Known open questions (seed list for Phase 1)

- Operator-to-operator agent transfer flow and liability handoff.
- Whether registration anchors anything on-chain at all.
- Post-release liability window for pre-release conduct (policy?).
- Attestor admission/governance for the initial network.
- Bond denomination/commitment privacy model (shielded amounts vs bands).
- Reputation decay function shape.
