/**
 * @bond/shared-types — foundation-only shared contracts.
 *
 * NOTE: No BOND business logic lives here yet. These are minimal
 * transport-level types used by the web/api shells to verify wiring.
 * Domain types (collateral, slashing, attestations, ZK proofs) are
 * planned and must be designed in a later milestone.
 */

/** Standard API envelope for future endpoints (foundation only). */
export interface ApiResponse<T> {
  data: T;
}

/** Health payload served by apps/api `GET /health`. */
export interface HealthResponse {
  status: "ok";
  version: string;
  service: "bond-api";
}
