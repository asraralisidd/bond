/**
 * Observability conventions (Phase 0 doc 14) without a logging framework.
 *
 * RULE: domain code never logs private material — no keys, witnesses,
 * blinding values, amounts, or evidence content. Logs reference entities
 * by ID only. This module provides the safe metadata shape plus an
 * allowlist-based picker so only correlation IDs can reach log output.
 */
import type {
  AgentId,
  AttestationId,
  RiskFlagId,
  TransactionId,
} from "./ids.js";

export interface DomainLogMetadata {
  readonly requestId: string | null;
  readonly agentId: AgentId | null;
  readonly riskFlagId: RiskFlagId | null;
  readonly attestationId: AttestationId | null;
  readonly transactionId: TransactionId | null;
}

export function emptyLogMetadata(): DomainLogMetadata {
  return {
    requestId: null,
    agentId: null,
    riskFlagId: null,
    attestationId: null,
    transactionId: null,
  };
}

/**
 * Builds log metadata from ID-only inputs. Accepts exactly the safe
 * correlation fields — there is no parameter slot for private content,
 * so private data cannot be passed by accident.
 */
export function toLogMetadata(input: {
  readonly requestId?: string | null;
  readonly agentId?: AgentId | null;
  readonly riskFlagId?: RiskFlagId | null;
  readonly attestationId?: AttestationId | null;
  readonly transactionId?: TransactionId | null;
}): DomainLogMetadata {
  return {
    requestId: input.requestId ?? null,
    agentId: input.agentId ?? null,
    riskFlagId: input.riskFlagId ?? null,
    attestationId: input.attestationId ?? null,
    transactionId: input.transactionId ?? null,
  };
}
