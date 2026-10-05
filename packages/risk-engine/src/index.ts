/**
 * @bond/risk-engine — advisory AI Risk Engine foundation (Phase 2).
 *
 * Analyzes normalized agent activity with deterministic rules and emits
 * structured RiskFlag domain objects. ADVISORY ONLY: the engine reports,
 * attestors verify, enforcement acts. Nothing here can slash, withdraw,
 * sign, submit, or mutate chain state — those capabilities do not exist
 * in this package (see boundary.test.ts for the enforced proof).
 */
export const RISK_ENGINE_STATUS = "rule-based-v1" as const;

export * from "./versions.js";
export * from "./input.js";
export * from "./evidence.js";
export * from "./rules.js";
export * from "./scoring.js";
export * from "./dedup.js";
export * from "./engine.js";
