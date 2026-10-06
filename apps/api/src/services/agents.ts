/**
 * Agent registry service. Registration binds (operator, platform,
 * externalRef) with duplicate-triple rejection (UNIQUE constraint);
 * status changes go through the Phase 1 transition machine.
 */
import { randomUUID } from "node:crypto";
import { parseAgentId, transitionAgentStatus } from "@bond/shared-types";
import type { AgentStatus } from "@bond/shared-types";
import {
  findAgentById,
  insertAgent,
  listAgentsByOperator,
  updateAgentStatus,
} from "../db/stores/registry.js";
import type { AgentRow } from "../db/stores/registry.js";
import { parseAgentType } from "../http/dto.js";
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import { recordEvent } from "./events.js";

export const AGENT_POLICY_VERSION = "bond-policy-v1";

export interface RegisterAgentInput {
  readonly operatorId: string;
  readonly platform: string;
  readonly agentType: string;
  readonly capabilities: readonly string[];
  readonly externalRef: string;
  readonly requestId?: string | null;
  readonly actor?: string;
}

function requireText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("INVALID_IDENTIFIER", `Invalid ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ApiError("INVALID_IDENTIFIER", `Invalid ${field}`);
  }
  return trimmed;
}

export async function registerAgentService(
  input: RegisterAgentInput,
): Promise<AgentRow> {
  const platform = requireText(input.platform, "platform", 64);
  const agentType = parseAgentType(input.agentType);
  const externalRef = requireText(input.externalRef, "externalRef", 512);
  if (!Array.isArray(input.capabilities)) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid capabilities");
  }
  if (input.capabilities.length > 100) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid capabilities");
  }
  for (const capability of input.capabilities) {
    if (
      typeof capability !== "string" ||
      capability.trim().length === 0 ||
      capability.length > 256
    ) {
      throw new ApiError("INVALID_IDENTIFIER", "Invalid capabilities");
    }
  }
  const id = randomUUID();
  try {
    return await withTransaction(async (client) => {
      const row = await insertAgent(
        {
          id,
          operatorId: input.operatorId,
          platform,
          agentType,
          capabilities: input.capabilities,
          externalRef,
          status: "REGISTERED",
          policyVersion: AGENT_POLICY_VERSION,
        },
        client,
      );
      await recordEvent(
        {
          type: "AGENT_REGISTERED",
          agentId: id,
          actor: input.actor ?? `operator:${input.operatorId}`,
          policyVersion: AGENT_POLICY_VERSION,
          requestId: input.requestId,
          payload: { operatorId: input.operatorId, status: "REGISTERED" },
        },
        client,
      );
      return row;
    });
  } catch (error) {
    if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
      throw new ApiError(
        "INVALID_IDENTIFIER",
        "Agent already registered for this operator/platform/reference",
      );
    }
    throw error;
  }
}

export async function getAgentService(
  id: string,
  operatorId: string,
): Promise<AgentRow> {
  parseAgentId(id);
  const row = await findAgentById(id);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Agent not found");
  }
  if (row.operator_id !== operatorId) {
    throw new ApiError("FORBIDDEN", "Not your resource");
  }
  return row;
}

export async function listAgentsService(
  operatorId: string,
  limit = 50,
): Promise<AgentRow[]> {
  return listAgentsByOperator(operatorId, Math.min(limit, 100));
}

export async function transitionAgentService(
  id: string,
  operatorId: string,
  to: AgentStatus,
  requestId?: string | null,
): Promise<AgentRow> {
  const row = await getAgentService(id, operatorId);
  const next = transitionAgentStatus(row.status as AgentStatus, to);
  return withTransaction(async (client) => {
    const updated = await updateAgentStatus(id, next, client);
    if (!updated) {
      throw new ApiError("NOT_FOUND", "Agent not found");
    }
    await recordEvent(
      {
        type: "AGENT_STATUS_CHANGED",
        agentId: id,
        actor: `operator:${operatorId}`,
        requestId,
        payload: { from: row.status, to: next },
      },
      client,
    );
    return updated;
  });
}
