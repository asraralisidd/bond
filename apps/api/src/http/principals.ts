/**
 * Authenticated principals: explicit, non-confusable identities.
 *
 * - operator: human/service account via session; owner-scoped resources.
 * - attestor: independent credential; attestor operations only.
 * - system: internal worker/reconciliation paths; never a bearer token,
 *   never constructed from request input (reserved for Phase 9.4+).
 *
 * Raw token strings never leave the middleware layer: services receive
 * principals, not credentials.
 */
export type PrincipalType = "operator" | "attestor" | "system";

export interface AuthenticatedPrincipal {
  readonly type: PrincipalType;
  /** Operator ID, attestor ID, or subsystem name. */
  readonly id: string;
  readonly sessionId?: string;
  readonly authenticatedAt: string;
}

export function operatorPrincipal(
  operatorId: string,
  sessionId: string,
): AuthenticatedPrincipal {
  return {
    type: "operator",
    id: operatorId,
    sessionId,
    authenticatedAt: new Date().toISOString(),
  };
}

export function attestorPrincipal(attestorId: string): AuthenticatedPrincipal {
  return {
    type: "attestor",
    id: attestorId,
    authenticatedAt: new Date().toISOString(),
  };
}

/** System principal for internal execution paths (no bearer credential). */
export function systemPrincipal(subsystem: string): AuthenticatedPrincipal {
  return {
    type: "system",
    id: `system:${subsystem}`,
    authenticatedAt: new Date().toISOString(),
  };
}
