# BOND Phase 0 — Architecture & Specification

> **Status: SPECIFICATION ONLY.** This directory contains architecture,
> domain concepts, and interface designs. It authorizes **no implementation**:
> no business logic, no migrations, no Midnight/Compact code, no ZK proofs,
> no wallet integration, no fake blockchain behavior.

## Reading order

| #   | Document                                  | Covers                                              |
| --- | ----------------------------------------- | --------------------------------------------------- |
| 01  | `01-product-vision-scope.md`              | Product vision, non-goals, platform-agnostic stance |
| 02  | `02-system-architecture.md`               | Layered architecture, security boundary, repo eval  |
| 03  | `03-agent-model-integration-lifecycle.md` | Agent model, integration, agent state machine       |
| 04  | `04-bond-lifecycle.md`                    | Bond lifecycle, off-chain vs on-chain state         |
| 05  | `05-risk-engine.md`                       | Risk Engine as untrusted decision support           |
| 06  | `06-attestor-system.md`                   | Independent attestation, 2-of-3 threshold concept   |
| 07  | `07-reputation.md`                        | Non-token reputation model                          |
| 08  | `08-privacy-zk-nullifiers.md`             | Privacy boundary, ZK eligibility, replay protection |
| 09  | `09-database-conceptual.md`               | Conceptual entities and relationships (no schema)   |
| 10  | `10-api-design.md`                        | Versioned API concept (`/api/v1/*`)                 |
| 11  | `11-frontend.md`                          | Screens and chain-state handling                    |
| 12  | `12-public-verification.md`               | Third-party verification without private data       |
| 13  | `13-security-model.md`                    | Threat-by-threat analysis                           |
| 14  | `14-observability.md`                     | IDs, events, audit trail (lightweight)              |
| 15  | `15-phase-dependencies.md`                | Phase order, out-of-scope list, Phase 1 acceptance  |
| 16  | `16-diagrams.md`                          | All 7 Mermaid architecture diagrams                 |
| ADR | `adr/ADR-001` … `adr/ADR-007`             | Architecture Decision Records                       |

## Conventions used across Phase 0

- **Conceptual, not final.** Field lists (e.g. `riskFlagId`, `confidence`) are
  concept inventories to bound later design — explicitly **not** SQL columns,
  TypeScript interfaces, or API schemas.
- **Off-chain vs on-chain.** Every state transition in this spec is labelled
  with where it is enforced. Anything enforced on-chain is marked
  **[CONTRACT-VERIFY]** to indicate it must be re-checked against official
  Midnight/Compact documentation at implementation time.
- **Version-sensitive items** are tagged **[VERIFY-MIDNIGHT]**: wallet APIs,
  proving systems, transaction lifecycle, and Compact language details. No
  such API is assumed or invented anywhere in Phase 0.
- **Security boundary.** The AI Risk Engine never authorizes or signs chain
  transactions. Enforcement requires independent attestation (see doc 06).
