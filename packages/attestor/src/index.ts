/**
 * @bond/attestor — independent Attestor System (Phase 3).
 *
 * Evaluates RiskFlags independently of the Risk Engine and produces
 * quorum decisions consumable by future enforcement. Output is decisions
 * only: no slashing, no withdrawals, no chain, no keys, no network.
 * (See boundary.test.ts for the enforced proof.)
 */
export const ATTESTOR_STATUS = "independent-v1" as const;

export * from "./versions.js";
export * from "./attestor.js";
export * from "./policy.js";
export * from "./evaluator.js";
export * from "./quorum.js";
export * from "./freshness.js";
export * from "./replay.js";
export * from "./binding.js";
export * from "./decision.js";
export * from "./projections.js";
