/**
 * Transport-level contracts (foundation shell, unchanged by Phase 1).
 * Used by apps/api and apps/web to verify wiring.
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
