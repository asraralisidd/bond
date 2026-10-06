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
import { readPublicState, readTransactionStatus } from "@bond/midnight-adapter";
import { query } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import {
  findLiveBondByAgent,
  updateAgentStatus,
  updateBond,
} from "../db/stores/registry.js";
import { markAgentSync } from "../db/stores/registry.js";
import {
  clearReconciliationRequired,
  findChainTransactionById,
  findChainTransactionByIdForUpdate,
  updateChainTransaction,
  upsertSyncCheckpoint,
} from "../db/stores/chain.js";
import { recordEvent } from "./events.js";
import { runPurposeFinalizer } from "./transactions.js";

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
      await withTransaction(async (client) => {
        await updateAgentStatus(row.id, chain.status, client);
        await markAgentSync(row.id, "conflicted", client);
        await recordEvent(
          {
            type: "CHAIN_DIVERGENCE_DETECTED",
            agentId: row.id,
            actor: "system:reconcile",
            payload: {
              field: "agent.status",
              database: row.status,
              chain: chain.status,
            },
          },
          client,
        );
        await markAgentSync(row.id, "in-sync", client);
      });
      healed += 1;
    }
    const bond = await findLiveBondByAgent(row.id);
    if (
      bond &&
      chain.bondStatus &&
      CHAIN_KNOWN_BOND_STATES.has(bond.status) &&
      bond.status !== chain.bondStatus
    ) {
      conflicts += 1;
      await withTransaction(async (client) => {
        await updateBond(
          bond.id,
          { status: chain.bondStatus ?? undefined },
          client,
        );
        await recordEvent(
          {
            type: "CHAIN_DIVERGENCE_DETECTED",
            agentId: row.id,
            bondId: bond.id,
            actor: "system:reconcile",
            payload: {
              field: "bond.status",
              database: bond.status,
              chain: chain.bondStatus,
            },
          },
          client,
        );
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

export interface TxReconciliationReport {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly unknownLeft: number;
}

/**
 * Transaction-row reconciliation (Phase 12): resolves SUBMITTED rows
 * against authoritative chain finality, one row at a time.
 *
 * Truth table per row (REAL handle required):
 * - chain CONFIRMED → DB CONFIRMED + confirmed flag + finalizer (once:
 *   already-CONFIRMED rows are skipped, never re-finalized).
 * - chain FAILED → DB FAILED with MIDNIGHT_CONFIRMATION_FAILED.
 * - chain unreachable/unknown → row untouched (absence of evidence is
 *   not evidence of failure); reconciliation_required stays set.
 * - Non-SUBMITTED rows are skipped (advance/confirm own those paths).
 *
 * Never manufactures confirmation: CONFIRMED is written only when the
 * adapter reports chain finality for this row's chain reference.
 */
export async function reconcileTransactionRows(
  handle: ChainHandle,
  limit = 25,
): Promise<TxReconciliationReport> {
  const report: {
    checked: number;
    confirmed: number;
    failed: number;
    unknownLeft: number;
  } = { checked: 0, confirmed: 0, failed: 0, unknownLeft: 0 };
  if (handle.mode !== "REAL" || handle.providers === null) {
    return { ...report };
  }
  const rows: {
    rows: { id: string; chain_tx_id: string | null; status: string }[];
  } = await query(
    `SELECT id, chain_tx_id, status FROM chain_transactions
     WHERE status = 'SUBMITTED' AND chain_tx_id IS NOT NULL
       AND dead_letter = FALSE
     ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  for (const row of rows.rows) {
    report.checked += 1;
    let outcome: "CONFIRMED" | "FAILED";
    try {
      outcome = await readTransactionStatus(handle, row.chain_tx_id as string);
    } catch {
      // Unknown/unreachable: leave the row for the next pass.
      report.unknownLeft += 1;
      continue;
    }
    await withTransaction(async (client) => {
      const fresh = await findChainTransactionByIdForUpdate(row.id, client);
      if (!fresh || fresh.status !== "SUBMITTED") {
        return;
      }
      if (outcome === "CONFIRMED") {
        await updateChainTransaction(
          row.id,
          { status: "CONFIRMED", confirmed: true },
          client,
        );
        // Mirror updates (same finalizers as the confirm path; the
        // row-lock + SUBMITTED check above makes this exactly-once).
        const current = await findChainTransactionById(row.id, client);
        if (current) {
          await runPurposeFinalizer(current, client);
        }
        await recordEvent(
          {
            type: "TRANSACTION_STATUS_CHANGED",
            agentId: fresh.agent_id,
            bondId: fresh.bond_id,
            txId: row.id,
            actor: "system:reconcile",
            payload: {
              transactionId: row.id,
              from: "SUBMITTED",
              to: "CONFIRMED",
              chainTxId: row.chain_tx_id,
            },
          },
          client,
        );
        report.confirmed += 1;
      } else {
        await updateChainTransaction(
          row.id,
          { status: "FAILED", lastError: "MIDNIGHT_CONFIRMATION_FAILED" },
          client,
        );
        await recordEvent(
          {
            type: "TRANSACTION_STATUS_CHANGED",
            agentId: fresh.agent_id,
            bondId: fresh.bond_id,
            txId: row.id,
            actor: "system:reconcile",
            payload: {
              transactionId: row.id,
              from: "SUBMITTED",
              to: "FAILED",
              chainTxId: row.chain_tx_id,
            },
          },
          client,
        );
        report.failed += 1;
      }
      await clearReconciliationRequired(row.id, client);
    });
  }
  return { ...report };
}
