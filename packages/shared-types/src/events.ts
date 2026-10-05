/**
 * Typed domain events (audit spine, Phase 0 docs 09/14).
 *
 * Events are typed, deterministic, and JSON-serializable. Each carries a
 * `eventVersion` ("v0") so the taxonomy can evolve. This module defines
 * the event shapes only — there is no broker, no transport, no logging
 * framework here.
 */
import type {
  AgentId,
  AttestationId,
  BondId,
  OperatorId,
  ProtocolEventId,
  ReputationId,
  RiskFlagId,
  SlashEventId,
  TransactionId,
} from "./ids.js";
import type {
  AgentStatus,
  BondStatus,
  ProtocolEventType,
  TransactionStatus,
} from "./enums.js";

interface BaseProtocolEvent<T extends ProtocolEventType, P> {
  readonly protocolEventId: ProtocolEventId;
  readonly type: T;
  readonly eventVersion: "v0";
  /** Correlation ID of the inbound request, when known (Phase 0 doc 14). */
  readonly requestId: string | null;
  readonly agentId: AgentId | null;
  readonly actor: string;
  readonly policyVersion: string | null;
  readonly occurredAt: string;
  readonly payload: P;
}

export type ProtocolEvent =
  | BaseProtocolEvent<
      "AGENT_REGISTERED",
      { readonly operatorId: OperatorId; readonly status: AgentStatus }
    >
  | BaseProtocolEvent<
      "BOND_CREATED",
      { readonly bondId: BondId; readonly status: BondStatus }
    >
  | BaseProtocolEvent<
      "RISK_FLAG_RAISED",
      { readonly riskFlagId: RiskFlagId; readonly severity: string }
    >
  | BaseProtocolEvent<
      "ATTESTATION_ISSUED",
      { readonly attestationId: AttestationId; readonly riskFlagId: RiskFlagId }
    >
  | BaseProtocolEvent<
      "SLASH_INITIATED",
      { readonly slashEventId: SlashEventId; readonly bondId: BondId }
    >
  | BaseProtocolEvent<
      "SLASH_COMPLETED",
      { readonly slashEventId: SlashEventId; readonly bondId: BondId }
    >
  | BaseProtocolEvent<
      "REPUTATION_UPDATED",
      { readonly reputationId: ReputationId; readonly score: number }
    >
  | BaseProtocolEvent<
      "WITHDRAWAL_REQUESTED",
      { readonly bondId: BondId; readonly transactionId: TransactionId }
    >
  | BaseProtocolEvent<
      "WITHDRAWAL_COMPLETED",
      { readonly bondId: BondId; readonly transactionId: TransactionId }
    >
  | BaseProtocolEvent<
      "TRANSACTION_STATUS_CHANGED",
      {
        readonly transactionId: TransactionId;
        readonly from: TransactionStatus;
        readonly to: TransactionStatus;
      }
    >;

export interface CreateProtocolEventInput<T extends ProtocolEventType> {
  readonly protocolEventId: ProtocolEventId;
  readonly type: T;
  readonly requestId?: string | null;
  readonly agentId?: AgentId | null;
  readonly actor: string;
  readonly policyVersion?: string | null;
  readonly occurredAt: string;
  readonly payload: Extract<ProtocolEvent, { readonly type: T }>["payload"];
}

/**
 * Constructs a typed protocol event. Payload shape is checked against the
 * event type at compile time.
 */
export function createProtocolEvent<T extends ProtocolEventType>(
  input: CreateProtocolEventInput<T>,
): Extract<ProtocolEvent, { readonly type: T }> {
  return {
    protocolEventId: input.protocolEventId,
    type: input.type,
    eventVersion: "v0",
    requestId: input.requestId ?? null,
    agentId: input.agentId ?? null,
    actor: input.actor,
    policyVersion: input.policyVersion ?? null,
    occurredAt: input.occurredAt,
    payload: input.payload,
  } as Extract<ProtocolEvent, { readonly type: T }>;
}

/** Narrow helper for exhaustive handling of the event union. */
export function assertNeverEvent(value: never): never {
  throw new Error(`Unhandled protocol event: ${JSON.stringify(value)}`);
}
