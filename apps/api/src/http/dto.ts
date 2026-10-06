/**
 * Response DTOs: the ONLY shape API responses may take.
 *
 * Database rows are NEVER serialized directly. Owner (private) views go
 * through explicit private DTOs; public views go exclusively through the
 * Phase 1/4/6 projection functions, which cannot represent private fields.
 */
import {
  parseAgentId,
  toPublicAgentView,
  toPublicBondView,
  toPublicReputationView,
  toPublicSlashRecord,
  verifyAgentPublic,
} from "@bond/shared-types";
import type { AgentType } from "@bond/shared-types";
import { ApiError } from "./errors.js";
import type { AgentRow, BondRow } from "../db/stores/registry.js";

export interface AgentPrivateView {
  readonly agentId: string;
  readonly platform: string;
  readonly agentType: string;
  readonly capabilities: readonly string[];
  readonly externalRef: string;
  readonly status: string;
  readonly policyVersion: string;
  readonly syncStatus: string;
}

export function toAgentPrivateView(row: AgentRow): AgentPrivateView {
  return {
    agentId: row.id,
    platform: row.platform,
    agentType: row.agent_type,
    capabilities: Array.isArray(row.capabilities)
      ? (row.capabilities as string[])
      : [],
    externalRef: row.external_ref,
    status: row.status,
    policyVersion: row.policy_version,
    syncStatus: row.sync_status,
  };
}

export interface BondPrivateView {
  readonly bondId: string;
  readonly agentId: string;
  readonly status: string;
  readonly policyVersion: string;
  readonly slashedTotalMinorUnits: string;
  readonly chainTxId: string | null;
  readonly withdrawalConsumed: boolean;
}

export function toBondPrivateView(row: BondRow): BondPrivateView {
  return {
    bondId: row.id,
    agentId: row.agent_id,
    status: row.status,
    policyVersion: row.policy_version,
    slashedTotalMinorUnits: row.slashed_total_minor_units,
    chainTxId: row.chain_tx_id,
    withdrawalConsumed: row.withdrawal_consumed,
  };
}

/** Public agent/status views delegate to the audited projection layer. */
export function parseAgentType(value: unknown): AgentType {
  if (
    value === "conversational" ||
    value === "coding" ||
    value === "workflow" ||
    value === "trading" ||
    value === "custom"
  ) {
    return value;
  }
  throw new ApiError("INVALID_IDENTIFIER", "Invalid agentType");
}

export function toAgentPublicView(input: {
  readonly agentId: string;
  readonly platform: string;
  readonly agentType: AgentType;
  readonly status:
    | "UNREGISTERED"
    | "REGISTERED"
    | "BONDED"
    | "ELIGIBLE"
    | "ACTIVE"
    | "FLAGGED"
    | "SLASHED"
    | "SUSPENDED"
    | "RESOLVED"
    | "WITHDRAWABLE";
  readonly reputationStanding: "good" | "probation" | "poor";
  readonly bondStatus:
    | "CREATED"
    | "PENDING"
    | "ACTIVE"
    | "LOCKED"
    | "PARTIALLY_SLASHED"
    | "FULLY_SLASHED"
    | "WITHDRAWABLE"
    | "WITHDRAWN"
    | "FAILED"
    | "CANCELLED";
  readonly openFlagCount: number;
}) {
  return toPublicAgentView({
    agent: {
      agentId: parseAgentId(input.agentId),
      platform: input.platform,
      agentType: input.agentType,
      status: input.status,
    },
    reputationStanding: input.reputationStanding,
    bondStatus: input.bondStatus,
    openFlagCount: input.openFlagCount,
  });
}

export function toBondPublicView(input: {
  readonly status:
    | "CREATED"
    | "PENDING"
    | "ACTIVE"
    | "LOCKED"
    | "PARTIALLY_SLASHED"
    | "FULLY_SLASHED"
    | "WITHDRAWABLE"
    | "WITHDRAWN"
    | "FAILED"
    | "CANCELLED";
  readonly policyVersion: string;
}) {
  return toPublicBondView(input);
}

export { toPublicReputationView, toPublicSlashRecord, verifyAgentPublic };
