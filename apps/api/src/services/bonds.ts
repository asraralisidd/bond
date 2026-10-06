/**
 * Bond lifecycle service. DB transitions are validated with the Phase 1
 * bond machine; chain effects happen only through transaction records
 * (see services/transactions.ts). Amounts stay opaque digit strings.
 */
import { randomUUID } from "node:crypto";
import { transitionBondStatus } from "@bond/shared-types";
import type { BondStatus } from "@bond/shared-types";
import {
  findBondById,
  findLiveBondByAgent,
  insertBond,
  updateBond,
} from "../db/stores/registry.js";
import type { BondRow } from "../db/stores/registry.js";
import { getAgentService } from "./agents.js";
import { ApiError } from "../http/errors.js";
import { recordEvent } from "./events.js";

export const BOND_POLICY_VERSION = "bond-policy-v1";

function requireDigits(value: string): void {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid commitment amount");
  }
}

export async function createBondService(input: {
  readonly operatorId: string;
  readonly agentId: string;
  readonly commitmentMinorUnits: string;
  readonly requestId?: string | null;
}): Promise<BondRow> {
  const agent = await getAgentService(input.agentId, input.operatorId);
  if (agent.status !== "REGISTERED") {
    throw new ApiError(
      "INVALID_BOND_TRANSITION",
      "Bond requires a REGISTERED agent",
    );
  }
  requireDigits(input.commitmentMinorUnits);
  const existing = await findLiveBondByAgent(input.agentId);
  if (existing) {
    throw new ApiError(
      "INVALID_BOND_TRANSITION",
      "Agent already has a live bond",
    );
  }
  const row = await insertBond({
    id: randomUUID(),
    agentId: input.agentId,
    operatorId: input.operatorId,
    commitmentMinorUnits: input.commitmentMinorUnits,
    status: "CREATED",
    policyVersion: BOND_POLICY_VERSION,
  });
  await recordEvent({
    type: "BOND_CREATED",
    agentId: input.agentId,
    bondId: row.id,
    actor: `operator:${input.operatorId}`,
    policyVersion: BOND_POLICY_VERSION,
    requestId: input.requestId,
    payload: { bondId: row.id, status: "CREATED" },
  });
  return row;
}

export async function getBondService(
  id: string,
  operatorId: string,
): Promise<BondRow> {
  const row = await findBondById(id);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Bond not found");
  }
  if (row.operator_id !== operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
  return row;
}

export async function transitionBondService(
  id: string,
  operatorId: string,
  to: BondStatus,
  requestId?: string | null,
): Promise<BondRow> {
  const row = await getBondService(id, operatorId);
  const next = transitionBondStatus(row.status as BondStatus, to);
  const updated = await updateBond(id, { status: next });
  if (!updated) {
    throw new ApiError("NOT_FOUND", "Bond not found");
  }
  await recordEvent({
    type: "BOND_STATUS_CHANGED",
    agentId: row.agent_id,
    bondId: id,
    actor: `operator:${operatorId}`,
    requestId,
    payload: { from: row.status, to: next },
  });
  return updated;
}
