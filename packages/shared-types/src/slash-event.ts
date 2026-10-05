/**
 * SlashEvent domain: an immutable enforcement-event record.
 *
 * A slash is its own object — never a boolean on Agent or Bond (Phase 0
 * doc 09). Amounts are private and cross into public views only through
 * projections.ts. Status: `initiated` (off-chain record) → `completed`
 * (confirmed enforcement). Completed events are immutable.
 */
import { DomainError } from "./errors.js";
import type {
  AgentId,
  AttestationId,
  BondId,
  DecisionId,
  RiskFlagId,
  SlashEventId,
  TransactionId,
} from "./ids.js";
import type { RiskCategory, RiskSeverity, SlashStatus } from "./enums.js";
import { isIsoTimestamp } from "./risk-flag.js";

export interface SlashEvent {
  readonly slashEventId: SlashEventId;
  readonly agentId: AgentId;
  readonly bondId: BondId;
  readonly attestationId: AttestationId;
  readonly decisionId: DecisionId;
  readonly riskFlagId: RiskFlagId;
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  /** PRIVATE. Opaque minor-unit string; see projections.ts. */
  readonly slashedMinorUnits: string;
  /** True when this slash consumed the entire remaining collateral. */
  readonly isFullSlash: boolean;
  readonly status: SlashStatus;
  readonly transactionId: TransactionId | null;
  readonly initiatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateSlashEventInput {
  readonly slashEventId: SlashEventId;
  readonly agentId: AgentId;
  readonly bondId: BondId;
  readonly attestationId: AttestationId;
  readonly decisionId: DecisionId;
  readonly riskFlagId: RiskFlagId;
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  readonly slashedMinorUnits: string;
  readonly isFullSlash: boolean;
  readonly transactionId?: TransactionId | null;
  readonly initiatedAt: string;
}

export function createSlashEvent(input: CreateSlashEventInput): SlashEvent {
  if (!isIsoTimestamp(input.initiatedAt)) {
    throw new DomainError(
      "INVALID_TIMESTAMP",
      "Invalid timestamp: initiatedAt",
      {},
    );
  }
  if (input.slashedMinorUnits.length === 0) {
    throw new DomainError(
      "INVALID_SLASH_EVENT",
      "SlashEvent slashedMinorUnits is required",
      { slashEventId: input.slashEventId },
    );
  }
  return {
    slashEventId: input.slashEventId,
    agentId: input.agentId,
    bondId: input.bondId,
    attestationId: input.attestationId,
    decisionId: input.decisionId,
    riskFlagId: input.riskFlagId,
    category: input.category,
    severity: input.severity,
    slashedMinorUnits: input.slashedMinorUnits,
    isFullSlash: input.isFullSlash,
    status: "initiated",
    transactionId: input.transactionId ?? null,
    initiatedAt: input.initiatedAt,
    completedAt: null,
  };
}

/**
 * Marks an initiated slash completed. Completed events are terminal and
 * immutable — completing twice throws.
 */
export function completeSlashEvent(
  event: SlashEvent,
  completedAt: string,
): SlashEvent {
  if (event.status !== "initiated") {
    throw new DomainError(
      "INVALID_SLASH_TRANSITION",
      "Only an initiated slash can complete",
      { slashEventId: event.slashEventId, status: event.status },
    );
  }
  if (!isIsoTimestamp(completedAt)) {
    throw new DomainError(
      "INVALID_TIMESTAMP",
      "Invalid timestamp: completedAt",
      {},
    );
  }
  return { ...event, status: "completed", completedAt };
}
