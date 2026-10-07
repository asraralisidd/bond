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
export type PrincipalType = "operator" | "attestor" | "system" | "agent";

export interface AuthenticatedPrincipal {
  readonly type: PrincipalType;
  /** Operator ID, attestor ID, agent ID, or subsystem name. */
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

/**
 * Agent principal: a registered agent acting under its own credential.
 * Carries the owning operator for ownership checks plus the credential
 * that authenticated the request and its capability allowlist.
 */
export interface AgentPrincipal extends AuthenticatedPrincipal {
  readonly type: "agent";
  readonly operatorId: string;
  readonly credentialId: string;
  readonly capabilities: readonly string[];
}

export function agentPrincipal(input: {
  agentId: string;
  operatorId: string;
  credentialId: string;
  capabilities: readonly string[];
}): AgentPrincipal {
  return {
    type: "agent",
    id: input.agentId,
    operatorId: input.operatorId,
    credentialId: input.credentialId,
    capabilities: input.capabilities,
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
