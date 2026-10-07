/**
 * @bond/policy-engine — deterministic agent policy evaluation (Phase 22).
 *
 * Pure authorization/risk-input layer: operator-owned policies over
 * normalized activity produce advisory PolicyDecisions. ADVISORY
 * ONLY: this package cannot slash, withdraw, sign, submit, attest,
 * or mutate chain state. Policy decisions feed the Risk Engine;
 * enforcement stays behind attestors (see boundary.test.ts).
 */
export const POLICY_ENGINE_STATUS = "policy-v1" as const;

export * from "./versions.js";
export * from "./policy.js";
export * from "./evaluate.js";
