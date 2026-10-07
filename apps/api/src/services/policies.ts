/**
 * Phase 22 agent policy management.
 *
 * Operator-owned, versioned, immutable history: creating a policy
 * supersedes the active version in the same transaction that
 * inserts the next one; PATCH amends by versioning, never by
 * mutating. Every change emits a protocol event (audit trail).
 * Agents never reach this service for writes — routes enforce
 * operator-only mutation.
 */
import { randomUUID } from "node:crypto";
import { validatePolicyInput } from "@bond/policy-engine";
import type {
  AgentPolicyInput,
  ResolvedAgentPolicy,
} from "@bond/policy-engine";
import type { PoolClient } from "pg";
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import { getAgentService } from "./agents.js";
import { recordEvent } from "./events.js";
import {
  getActiveAgentPolicy,
  insertAgentPolicy,
  listAgentPolicies,
  nextPolicyVersion,
  supersedeActivePolicies,
} from "../db/stores/policies.js";
import type { AgentPolicyRow } from "../db/stores/policies.js";

function toDomainError(error: unknown): ApiError {
  if (error instanceof Error && error.name === "DomainError") {
    const code = (error as { code?: string }).code ?? "INVALID_POLICY";
    return new ApiError(code, error.message);
  }
  throw error;
}

function parseStringList(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null) {
        return null;
      }
      if (Array.isArray(parsed)) {
        return (parsed as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
    } catch {
      // Fall through to empty-allow below.
    }
    return [];
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

function toNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

/** Maps a stored row to the evaluator's resolved shape (pure data). */
export function rowToResolvedPolicy(row: AgentPolicyRow): ResolvedAgentPolicy {
  return {
    version: row.version,
    status: row.status === "superseded" ? "superseded" : "active",
    allowedActions: parseStringList(row.allowed_actions),
    deniedActions: parseStringList(row.denied_actions) ?? [],
    allowedTools: parseStringList(row.allowed_tools),
    deniedTools: parseStringList(row.denied_tools) ?? [],
    allowedProviders: parseStringList(row.allowed_providers),
    deniedProviders: parseStringList(row.denied_providers) ?? [],
    allowedModels: parseStringList(row.allowed_models),
    deniedModels: parseStringList(row.denied_models) ?? [],
    maxInputTokens: toNumber(row.max_input_tokens),
    maxOutputTokens: toNumber(row.max_output_tokens),
    maxTotalTokens: toNumber(row.max_total_tokens),
    maxTotalTokensPerWindow: toNumber(row.max_total_tokens_per_window),
    tokenWindowSeconds: toNumber(row.token_window_seconds),
    maxRequestsPerWindow: toNumber(row.max_requests_per_window),
    requestWindowSeconds: toNumber(row.request_window_seconds),
    maxCostMinorUnitsPerRequest: row.max_cost_minor_units_per_request,
    maxCostMinorUnitsPerWindow: row.max_cost_minor_units_per_window,
    costWindowSeconds: toNumber(row.cost_window_seconds),
    maxTransferMinorUnits: row.max_transfer_minor_units,
  };
}

/** Governing-policy label stamped on decisions and flags. */
export function policyVersionLabel(version: number): string {
  return `agent-policy-v${version}`;
}

export interface PolicyView {
  readonly policyId: string;
  readonly agentId: string;
  readonly version: number;
  readonly status: string;
  readonly fields: Omit<ResolvedAgentPolicy, "version" | "status">;
  readonly createdBy: string;
  readonly createdAt: string;
}

function toView(row: AgentPolicyRow, agentId: string): PolicyView {
  const {
    version: _version,
    status: _status,
    ...fields
  } = rowToResolvedPolicy(row);
  return {
    policyId: row.id,
    agentId,
    version: row.version,
    status: row.status,
    fields,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function createPolicyService(input: {
  readonly operatorId: string;
  readonly agentId: string;
  readonly policy: AgentPolicyInput;
  readonly requestId?: string | null;
}): Promise<PolicyView> {
  await getAgentService(input.agentId, input.operatorId);
  let fields;
  try {
    fields = validatePolicyInput(input.policy);
  } catch (error) {
    throw toDomainError(error);
  }
  return withTransaction(async (client) => {
    const version = await nextPolicyVersion(input.agentId, client);
    await supersedeActivePolicies(input.agentId, client);
    const id = `pol_${randomUUID()}`;
    try {
      await insertAgentPolicy(
        {
          id,
          agentId: input.agentId,
          version,
          fields,
          createdBy: `operator:${input.operatorId}`,
        },
        client,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "23505"
      ) {
        throw new ApiError(
          "POLICY_VERSION_CONFLICT",
          "Concurrent policy update; retry with the latest version",
        );
      }
      throw error;
    }
    await recordEvent(
      {
        type: "POLICY_CREATED",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { policyId: id, version },
      },
      client,
    );
    return {
      policyId: id,
      agentId: input.agentId,
      version,
      status: "active",
      fields,
      createdBy: `operator:${input.operatorId}`,
      createdAt: new Date().toISOString(),
    };
  });
}

export async function updatePolicyService(input: {
  readonly operatorId: string;
  readonly agentId: string;
  readonly expectedVersion: number;
  readonly patch: {
    [K in keyof AgentPolicyInput]?: AgentPolicyInput[K] | null;
  };
  readonly requestId?: string | null;
}): Promise<PolicyView> {
  await getAgentService(input.agentId, input.operatorId);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ApiError("INVALID_POLICY", "expectedVersion must be >= 1");
  }
  return withTransaction(async (client) => {
    const active = await getActiveAgentPolicy(input.agentId, client);
    if (!active) {
      throw new ApiError("NOT_FOUND", "No active policy for agent");
    }
    if (active.version !== input.expectedVersion) {
      throw new ApiError(
        "POLICY_VERSION_CONFLICT",
        `Policy is at version ${active.version}, not ${input.expectedVersion}`,
      );
    }
    // Amendment by versioning: merge the patch over the active
    // fields, validate the whole, insert as the next version.
    const current = rowToResolvedPolicy(active);
    const merged: AgentPolicyInput = {
      allowedActions:
        input.patch.allowedActions ?? current.allowedActions ?? undefined,
      deniedActions: input.patch.deniedActions ?? current.deniedActions,
      allowedTools:
        input.patch.allowedTools ?? current.allowedTools ?? undefined,
      deniedTools: input.patch.deniedTools ?? current.deniedTools,
      allowedProviders:
        input.patch.allowedProviders ?? current.allowedProviders ?? undefined,
      deniedProviders: input.patch.deniedProviders ?? current.deniedProviders,
      allowedModels:
        input.patch.allowedModels ?? current.allowedModels ?? undefined,
      deniedModels: input.patch.deniedModels ?? current.deniedModels,
      maxInputTokens:
        input.patch.maxInputTokens ?? current.maxInputTokens ?? undefined,
      maxOutputTokens:
        input.patch.maxOutputTokens ?? current.maxOutputTokens ?? undefined,
      maxTotalTokens:
        input.patch.maxTotalTokens ?? current.maxTotalTokens ?? undefined,
      maxTotalTokensPerWindow:
        input.patch.maxTotalTokensPerWindow ??
        current.maxTotalTokensPerWindow ??
        undefined,
      tokenWindowSeconds:
        input.patch.tokenWindowSeconds ??
        current.tokenWindowSeconds ??
        undefined,
      maxRequestsPerWindow:
        input.patch.maxRequestsPerWindow ??
        current.maxRequestsPerWindow ??
        undefined,
      requestWindowSeconds:
        input.patch.requestWindowSeconds ??
        current.requestWindowSeconds ??
        undefined,
      maxCostMinorUnitsPerRequest:
        input.patch.maxCostMinorUnitsPerRequest ??
        current.maxCostMinorUnitsPerRequest ??
        undefined,
      maxCostMinorUnitsPerWindow:
        input.patch.maxCostMinorUnitsPerWindow ??
        current.maxCostMinorUnitsPerWindow ??
        undefined,
      costWindowSeconds:
        input.patch.costWindowSeconds ?? current.costWindowSeconds ?? undefined,
      maxTransferMinorUnits:
        input.patch.maxTransferMinorUnits ??
        current.maxTransferMinorUnits ??
        undefined,
    };
    let fields;
    try {
      fields = validatePolicyInput(merged);
    } catch (error) {
      throw toDomainError(error);
    }
    // Clearing a windowed pair requires clearing BOTH sides: a patch
    // carrying an explicit null for one side drops the pair. The
    // merge above cannot express that (?? keeps current), so an
    // explicit-null pair member is honored here.
    const cleared = clearExplicitNullPairs(input.patch, fields);
    const version = active.version + 1;
    await supersedeActivePolicies(input.agentId, client);
    const id = `pol_${randomUUID()}`;
    try {
      await insertAgentPolicy(
        {
          id,
          agentId: input.agentId,
          version,
          fields: cleared,
          createdBy: `operator:${input.operatorId}`,
        },
        client,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "23505"
      ) {
        throw new ApiError(
          "POLICY_VERSION_CONFLICT",
          "Concurrent policy update; retry with the latest version",
        );
      }
      throw error;
    }
    await recordEvent(
      {
        type: "POLICY_UPDATED",
        agentId: input.agentId,
        actor: `operator:${input.operatorId}`,
        requestId: input.requestId,
        payload: { policyId: id, version, supersedes: active.version },
      },
      client,
    );
    return {
      policyId: id,
      agentId: input.agentId,
      version,
      status: "active",
      fields: cleared,
      createdBy: `operator:${input.operatorId}`,
      createdAt: new Date().toISOString(),
    };
  });
}

type ValidatedFields = Omit<ResolvedAgentPolicy, "version" | "status">;

/**
 * Explicit-null clearing for windowed pairs: `{maxXPerWindow: null}`
 * (or `{xWindowSeconds: null}`) drops the whole pair even when the
 * active version sets it. Single (non-windowed) explicit nulls clear
 * that field alone.
 */
function clearExplicitNullPairs(
  patch: { [K in keyof AgentPolicyInput]?: AgentPolicyInput[K] | null },
  fields: ValidatedFields,
): ValidatedFields {
  const pairs: ReadonlyArray<
    readonly [keyof AgentPolicyInput, keyof AgentPolicyInput]
  > = [
    ["maxTotalTokensPerWindow", "tokenWindowSeconds"],
    ["maxRequestsPerWindow", "requestWindowSeconds"],
    ["maxCostMinorUnitsPerWindow", "costWindowSeconds"],
  ];
  let out = fields;
  for (const [limitKey, windowKey] of pairs) {
    if (
      (limitKey in patch && patch[limitKey] === null) ||
      (windowKey in patch && patch[windowKey] === null)
    ) {
      out = { ...out, [limitKey]: null, [windowKey]: null };
    }
  }
  const singles: ReadonlyArray<keyof AgentPolicyInput> = [
    "allowedActions",
    "allowedTools",
    "allowedProviders",
    "allowedModels",
    "maxInputTokens",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxCostMinorUnitsPerRequest",
    "maxTransferMinorUnits",
  ];
  for (const key of singles) {
    if (key in patch && patch[key as keyof AgentPolicyInput] === null) {
      out = { ...out, [key]: null };
    }
  }
  return out;
}

export async function getPolicyService(input: {
  readonly operatorId: string;
  readonly agentId: string;
}): Promise<PolicyView | null> {
  await getAgentService(input.agentId, input.operatorId);
  const row = await getActiveAgentPolicy(input.agentId);
  return row ? toView(row, input.agentId) : null;
}

export async function listPolicyHistoryService(input: {
  readonly operatorId: string;
  readonly agentId: string;
  readonly limit: number;
}): Promise<PolicyView[]> {
  await getAgentService(input.agentId, input.operatorId);
  const rows = await listAgentPolicies(input.agentId, input.limit);
  return rows.map((row) => toView(row, input.agentId));
}

export async function getActivePolicyForAnalysis(
  agentId: string,
  client?: PoolClient,
): Promise<ResolvedAgentPolicy | null> {
  const row = await getActiveAgentPolicy(agentId, client);
  return row ? rowToResolvedPolicy(row) : null;
}
