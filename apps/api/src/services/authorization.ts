/**
 * Central ownership enforcement. Every owner-scoped read or mutation
 * resolves through these helpers — no route performs ad-hoc
 * operator_id comparisons.
 *
 * Chain transactions carry no operator column by design, so ownership
 * resolves transitively: agent first, then bond. Unlinked (orphan)
 * transactions are system-internal and denied to operators.
 */
import { ApiError } from "../http/errors.js";
import {
  parseAgentId,
  parseAttestationId,
  parseBondId,
  parseRiskFlagId,
} from "@bond/shared-types";
import { findAgentById, findBondById } from "../db/stores/registry.js";
import { findAttestationById } from "../db/stores/attestation.js";
import { findRiskFlagById } from "../db/stores/risk.js";
import type { ChainTxRow } from "../db/stores/chain.js";

export async function requireAgentOwnership(
  agentId: string,
  operatorId: string,
): Promise<void> {
  parseAgentId(agentId);
  const agent = await findAgentById(agentId);
  if (!agent) {
    throw new ApiError("NOT_FOUND", "Agent not found");
  }
  if (agent.operator_id !== operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
}

export async function requireBondOwnership(
  bondId: string,
  operatorId: string,
): Promise<void> {
  parseBondId(bondId);
  const bond = await findBondById(bondId);
  if (!bond) {
    throw new ApiError("NOT_FOUND", "Bond not found");
  }
  if (bond.operator_id !== operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
}

export async function requireTxOwnership(
  tx: ChainTxRow,
  operatorId: string,
): Promise<void> {
  if (tx.agent_id) {
    await requireAgentOwnership(tx.agent_id, operatorId);
    return;
  }
  if (tx.bond_id) {
    await requireBondOwnership(tx.bond_id, operatorId);
    return;
  }
  throw new ApiError("FORBIDDEN", "Not your resource");
}

export async function requireFlagOwnership(
  flagId: string,
  operatorId: string,
): Promise<void> {
  parseRiskFlagId(flagId);
  const flag = await findRiskFlagById(flagId);
  if (!flag) {
    throw new ApiError("NOT_FOUND", "Risk flag not found");
  }
  await requireAgentOwnership(flag.agent_id, operatorId);
}

export async function requireAttestationOwnership(
  attestationId: string,
  operatorId: string,
): Promise<void> {
  parseAttestationId(attestationId);
  const attestation = await findAttestationById(attestationId);
  if (!attestation) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  await requireFlagOwnership(attestation.flag_id, operatorId);
}
