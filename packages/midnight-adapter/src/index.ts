/**
 * @bond/midnight-adapter — Midnight integration seam (Phase 5).
 *
 * SOLE chain integration point for BOND. Carries:
 * - validated BOND-level request builders (requests.ts),
 * - domain ↔ Compact encoding (encoding.ts),
 * - witness callbacks + private-state shape (witnesses.ts),
 * - compiled-contract wiring from VERIFIED artifacts (compiled.ts),
 * - environment configuration with explicit modes (config.ts),
 * - verified provider assembly (providers.ts),
 * - SIMULATED execution + REAL submission/confirmation paths (client.ts).
 *
 * Modes: SIMULATED (labeled in-memory rules), REAL (live submission),
 * UNAVAILABLE (refuse). Nothing here fakes chain activity.
 */
export const MIDNIGHT_ADAPTER_STATUS = "adapter-v2" as const;

export * from "./versions.js";
export * from "./metadata.js";
export * from "./requests.js";
export * from "./encoding.js";
export * from "./eligibility.js";
export * from "./witnesses.js";
export * from "./compiled.js";
export * from "./config.js";
export * from "./providers.js";
export * from "./errors.js";
export * from "./client.js";
