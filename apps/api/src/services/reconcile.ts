/**
 * Chain reconciliation: observes chain-authoritative state and heals
 * divergent DB mirrors. Chain wins for chain-authoritative fields;
 * every divergence is recorded as a protocol event — never silently
 * overwritten.
 *
 * Compared (chain-known states only): agent status, bond status (only
 * for states that exist on-chain; CREATED/PENDING/FAILED/CANCELLED are
 * off-chain intents), slash counts are informational.
 */
import type { ChainHandle } from "@bond/midnight-adapter";
import { readPublicState } from "@bond/midnight-adapter";
import { query } from "../db/pool.js";
import {
  findLiveBondByAgent,
  updateAgentStatus,
  updateBond,
} from "../db/stores/registry.js";
import { markAgentSync } from "../db/stores/registry.js";
import { upsertSyncCheckpoint } from "../db/stores/chain.js";
import { recordEvent } from "./events.js";

const CHAIN_KNOWN_BOND_STATES = new Set([
  "ACTIVE",
  "LOCKED",
  "PARTIALLY_SLASHED",
  "FULLY_SLASHED",
  "WITHDRAWABLE",
  "WITHDRAWN",
]);

export interface ReconciliationReport {
  readonly checked: number;
  readonly conflicts: number;
  readonly healed: number;
}

export async function runReconciliationOnce(
  handle: ChainHandle,
  contractAddress: string,
  limit = 50,
): Promise<ReconciliationReport> {
  let checked = 0;
  let conflicts = 0;
  let healed = 0;
  const agents: { rows: { id: string; status: string }[] } = await query(
    "SELECT id, status FROM agents ORDER BY created_at ASC LIMIT $1",
    [limit],
  );
  const ids = agents.rows.map((r) => r.id);
  if (ids.length === 0) {
    await upsertSyncCheckpoint(contractAddress, new Date().toISOString(), 0);
    return { checked, conflicts, healed };
  }
  let views: { agentId: string; status: string; bondStatus: string | null }[];
  try {
    views = [...(await readPublicState(handle, { agentIds: ids }))];
  } catch {
    return { checked, conflicts, healed };
  }
  const byId = new Map(views.map((v) => [v.agentId, v]));
  for (const row of agents.rows) {
    checked += 1;
    const chain = byId.get(row.id);
    if (!chain) {
      continue;
    }
    if (chain.status !== row.status) {
      conflicts += 1;
      await updateAgentStatus(row.id, chain.status);
      await markAgentSync(row.id, "conflicted");
      await recordEvent({
        type: "CHAIN_DIVERGENCE_DETECTED",
        agentId: row.id,
        actor: "system:reconcile",
        payload: {
          field: "agent.status",
          database: row.status,
          chain: chain.status,
        },
      });
      healed += 1;
      await markAgentSync(row.id, "in-sync");
    }
    const bond = await findLiveBondByAgent(row.id);
    if (
      bond &&
      chain.bondStatus &&
      CHAIN_KNOWN_BOND_STATES.has(bond.status) &&
      bond.status !== chain.bondStatus
    ) {
      conflicts += 1;
      await updateBond(bond.id, { status: chain.bondStatus });
      await recordEvent({
        type: "CHAIN_DIVERGENCE_DETECTED",
        agentId: row.id,
        bondId: bond.id,
        actor: "system:reconcile",
        payload: {
          field: "bond.status",
          database: bond.status,
          chain: chain.bondStatus,
        },
      });
      healed += 1;
    }
  }
  await upsertSyncCheckpoint(
    contractAddress,
    new Date().toISOString(),
    conflicts,
  );
  return { checked, conflicts, healed };
}
