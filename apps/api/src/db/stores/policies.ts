/**
 * Phase 22 agent policy stores.
 *
 * agent_policies: immutable versions, one ACTIVE per agent. New
 * versions supersede in the same transaction that inserts them;
 * UNIQUE (agent_id, version) turns concurrent creators into an
 * explicit version conflict, never a fork. No UPDATE/DELETE
 * accessors exist — PATCH creates a version, it never mutates.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface AgentPolicyRow {
  readonly id: string;
  readonly agent_id: string;
  readonly version: number;
  readonly status: string;
  readonly allowed_actions: string[] | null;
  readonly denied_actions: string[];
  readonly allowed_tools: string[] | null;
  readonly denied_tools: string[];
  readonly allowed_providers: string[] | null;
  readonly denied_providers: string[];
  readonly allowed_models: string[] | null;
  readonly denied_models: string[];
  readonly max_input_tokens: string | null;
  readonly max_output_tokens: string | null;
  readonly max_total_tokens: string | null;
  readonly max_total_tokens_per_window: string | null;
  readonly token_window_seconds: string | null;
  readonly max_requests_per_window: string | null;
  readonly request_window_seconds: string | null;
  readonly max_cost_minor_units_per_request: string | null;
  readonly max_cost_minor_units_per_window: string | null;
  readonly cost_window_seconds: string | null;
  readonly max_transfer_minor_units: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

const POLICY_COLUMNS = `id, agent_id, version, status,
  allowed_actions, denied_actions, allowed_tools, denied_tools,
  allowed_providers, denied_providers, allowed_models, denied_models,
  max_input_tokens, max_output_tokens, max_total_tokens,
  max_total_tokens_per_window, token_window_seconds,
  max_requests_per_window, request_window_seconds,
  max_cost_minor_units_per_request, max_cost_minor_units_per_window,
  cost_window_seconds, max_transfer_minor_units, created_by, created_at`;

export async function insertAgentPolicy(
  input: {
    readonly id: string;
    readonly agentId: string;
    readonly version: number;
    readonly fields: {
      readonly allowedActions: readonly string[] | null;
      readonly deniedActions: readonly string[];
      readonly allowedTools: readonly string[] | null;
      readonly deniedTools: readonly string[];
      readonly allowedProviders: readonly string[] | null;
      readonly deniedProviders: readonly string[];
      readonly allowedModels: readonly string[] | null;
      readonly deniedModels: readonly string[];
      readonly maxInputTokens: number | null;
      readonly maxOutputTokens: number | null;
      readonly maxTotalTokens: number | null;
      readonly maxTotalTokensPerWindow: number | null;
      readonly tokenWindowSeconds: number | null;
      readonly maxRequestsPerWindow: number | null;
      readonly requestWindowSeconds: number | null;
      readonly maxCostMinorUnitsPerRequest: string | null;
      readonly maxCostMinorUnitsPerWindow: string | null;
      readonly costWindowSeconds: number | null;
      readonly maxTransferMinorUnits: string | null;
    };
    readonly createdBy: string;
  },
  client: PoolClient,
): Promise<void> {
  const f = input.fields;
  await query(
    `INSERT INTO agent_policies
       (id, agent_id, version, status,
        allowed_actions, denied_actions, allowed_tools, denied_tools,
        allowed_providers, denied_providers, allowed_models, denied_models,
        max_input_tokens, max_output_tokens, max_total_tokens,
        max_total_tokens_per_window, token_window_seconds,
        max_requests_per_window, request_window_seconds,
        max_cost_minor_units_per_request, max_cost_minor_units_per_window,
        cost_window_seconds, max_transfer_minor_units, created_by)
      VALUES ($1, $2, $3, 'active',
        $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      input.id,
      input.agentId,
      input.version,
      f.allowedActions === null ? null : JSON.stringify(f.allowedActions),
      JSON.stringify(f.deniedActions),
      f.allowedTools === null ? null : JSON.stringify(f.allowedTools),
      JSON.stringify(f.deniedTools),
      f.allowedProviders === null ? null : JSON.stringify(f.allowedProviders),
      JSON.stringify(f.deniedProviders),
      f.allowedModels === null ? null : JSON.stringify(f.allowedModels),
      JSON.stringify(f.deniedModels),
      f.maxInputTokens,
      f.maxOutputTokens,
      f.maxTotalTokens,
      f.maxTotalTokensPerWindow,
      f.tokenWindowSeconds,
      f.maxRequestsPerWindow,
      f.requestWindowSeconds,
      f.maxCostMinorUnitsPerRequest,
      f.maxCostMinorUnitsPerWindow,
      f.costWindowSeconds,
      f.maxTransferMinorUnits,
      input.createdBy,
    ],
    client,
  );
}

export async function getActiveAgentPolicy(
  agentId: string,
  client?: PoolClient,
): Promise<AgentPolicyRow | null> {
  const result = await query<AgentPolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM agent_policies
      WHERE agent_id = $1 AND status = 'active'`,
    [agentId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function nextPolicyVersion(
  agentId: string,
  client: PoolClient,
): Promise<number> {
  const result = await query<{ max: string | null }>(
    `SELECT MAX(version) AS max FROM agent_policies WHERE agent_id = $1`,
    [agentId],
    client,
  );
  return Number(result.rows[0]?.max ?? 0) + 1;
}

export async function supersedeActivePolicies(
  agentId: string,
  client: PoolClient,
): Promise<void> {
  await query(
    `UPDATE agent_policies SET status = 'superseded'
      WHERE agent_id = $1 AND status = 'active'`,
    [agentId],
    client,
  );
}

export async function listAgentPolicies(
  agentId: string,
  limit: number,
  client?: PoolClient,
): Promise<AgentPolicyRow[]> {
  const result = await query<AgentPolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM agent_policies
      WHERE agent_id = $1 ORDER BY version DESC LIMIT $2`,
    [agentId, limit],
    client,
  );
  return result.rows;
}
