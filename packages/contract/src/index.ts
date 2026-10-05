/**
 * @bond/contract — authoritative enforcement rule model (Phase 4).
 *
 * Normative, pure-TypeScript specification of the exact state machine
 * future Compact circuits must implement 1:1. No chain, no wallet, no
 * crypto, no network. No Compact source is shipped in Phase 4 because no
 * verified compiler is available to check it against — inventing syntax
 * would be worse than specifying rules precisely (see docs/phase-4).
 */
export * from "./versions.js";
export * from "./state.js";
export * from "./entrypoints.js";
export * from "./projections.js";
