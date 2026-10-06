/**
 * Agent + bond stores. Status columns are chain mirrors for lifecycle
 * state; transitions are validated in TypeScript (Phase 1 machines)
 * before any write. Amount columns are opaque digit strings.
 */
import { query } from "../pool.js";
import type { PoolClient } from "pg";

export interface AgentRow {
  readonly id: string;
  readonly operator_id: string;
  readonly platform: string;
  readonly agent_type: string;
  readonly capabilities: unknown;
  readonly external_ref: string;
  readonly status: string;
  readonly policy_version: string;
  readonly sync_status: string;
}

export interface InsertAgent {
  readonly id: string;
  readonly operatorId: string;
  readonly platform: string;
  readonly agentType: string;
  readonly capabilities: readonly string[];
  readonly externalRef: string;
  readonly status: string;
  readonly policyVersion: string;
}

const AGENT_COLUMNS = `id, operator_id, platform, agent_type, capabilities,
  external_ref, status, policy_version, sync_status`;

export async function insertAgent(
  agent: InsertAgent,
  client?: PoolClient,
): Promise<AgentRow> {
  const result = await query<AgentRow>(
    `INSERT INTO agents
       (id, operator_id, platform, agent_type, capabilities, external_ref, status, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${AGENT_COLUMNS}`,
    [
      agent.id,
      agent.operatorId,
      agent.platform,
      agent.agentType,
      JSON.stringify(agent.capabilities),
      agent.externalRef,
      agent.status,
      agent.policyVersion,
    ],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertAgent returned no row");
  }
  return row;
}

export async function findAgentById(
  id: string,
  client?: PoolClient,
): Promise<AgentRow | null> {
  const result = await query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function listAgentsByOperator(
  operatorId: string,
  limit: number,
  client?: PoolClient,
): Promise<AgentRow[]> {
  const result = await query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents
     WHERE operator_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [operatorId, limit],
    client,
  );
  return result.rows;
}

export async function updateAgentStatus(
  id: string,
  status: string,
  client?: PoolClient,
): Promise<AgentRow | null> {
  const result = await query<AgentRow>(
    `UPDATE agents SET status = $2, updated_at = now()
     WHERE id = $1 RETURNING ${AGENT_COLUMNS}`,
    [id, status],
    client,
  );
  return result.rows[0] ?? null;
}

export async function markAgentSync(
  id: string,
  syncStatus: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    "UPDATE agents SET sync_status = $2, updated_at = now() WHERE id = $1",
    [id, syncStatus],
    client,
  );
}

export interface BondRow {
  readonly id: string;
  readonly agent_id: string;
  readonly operator_id: string;
  readonly commitment_minor_units: string;
  readonly slashed_total_minor_units: string;
  readonly status: string;
  readonly policy_version: string;
  readonly chain_tx_id: string | null;
  readonly withdrawal_consumed: boolean;
}

export interface InsertBond {
  readonly id: string;
  readonly agentId: string;
  readonly operatorId: string;
  readonly commitmentMinorUnits: string;
  readonly status: string;
  readonly policyVersion: string;
}

const BOND_COLUMNS = `id, agent_id, operator_id, commitment_minor_units,
  slashed_total_minor_units, status, policy_version, chain_tx_id,
  withdrawal_consumed`;

export async function insertBond(
  bond: InsertBond,
  client?: PoolClient,
): Promise<BondRow> {
  const result = await query<BondRow>(
    `INSERT INTO bonds
       (id, agent_id, operator_id, commitment_minor_units, status, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${BOND_COLUMNS}`,
    [
      bond.id,
      bond.agentId,
      bond.operatorId,
      bond.commitmentMinorUnits,
      bond.status,
      bond.policyVersion,
    ],
    client,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertBond returned no row");
  }
  return row;
}

export async function findBondById(
  id: string,
  client?: PoolClient,
): Promise<BondRow | null> {
  const result = await query<BondRow>(
    `SELECT ${BOND_COLUMNS} FROM bonds WHERE id = $1`,
    [id],
    client,
  );
  return result.rows[0] ?? null;
}

export async function findLiveBondByAgent(
  agentId: string,
  client?: PoolClient,
): Promise<BondRow | null> {
  const result = await query<BondRow>(
    `SELECT ${BOND_COLUMNS} FROM bonds
     WHERE agent_id = $1
       AND status IN ('ACTIVE', 'LOCKED', 'PARTIALLY_SLASHED', 'WITHDRAWABLE')
     LIMIT 1`,
    [agentId],
    client,
  );
  return result.rows[0] ?? null;
}

export interface UpdateBondState {
  readonly status?: string;
  readonly slashedTotalMinorUnits?: string;
  readonly chainTxId?: string | null;
  readonly withdrawalConsumed?: boolean;
}

export async function updateBond(
  id: string,
  update: UpdateBondState,
  client?: PoolClient,
): Promise<BondRow | null> {
  const result = await query<BondRow>(
    `UPDATE bonds SET
       status = COALESCE($2, status),
       slashed_total_minor_units = COALESCE($3, slashed_total_minor_units),
       chain_tx_id = COALESCE($4, chain_tx_id),
       withdrawal_consumed = COALESCE($5, withdrawal_consumed),
       updated_at = now()
     WHERE id = $1 RETURNING ${BOND_COLUMNS}`,
    [
      id,
      update.status ?? null,
      update.slashedTotalMinorUnits ?? null,
      update.chainTxId ?? null,
      update.withdrawalConsumed ?? null,
    ],
    client,
  );
  return result.rows[0] ?? null;
}
