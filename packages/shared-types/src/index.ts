/**
 * @bond/shared-types — BOND Phase 1 domain model.
 *
 * Strongly typed, pure, deterministic domain foundation: branded IDs,
 * lifecycle state machines (agent, bond, risk flag, transaction),
 * advisory risk flags, independent attestations, slash events,
 * derived reputation, typed protocol events, public projections with a
 * privacy boundary, structured domain errors, and log-safe metadata.
 *
 * What is NOT here (later phases): chain/wallet/ZK/crypto, AI inference,
 * persistence, HTTP, UI. RiskFlag is decision support only — it cannot
 * move funds or mutate chain state.
 */

export type { ApiResponse, HealthResponse } from "./transport.js";

export * from "./ids.js";
export * from "./enums.js";
export * from "./errors.js";
export * from "./agent.js";
export * from "./bond.js";
export * from "./risk-flag.js";
export * from "./attestation.js";
export * from "./slash-event.js";
export * from "./reputation.js";
export * from "./delegation.js";
export * from "./transaction.js";
export * from "./events.js";
export * from "./projections.js";
export * from "./observability.js";
