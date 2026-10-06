/**
 * SIMULATED purpose executors: purpose → adapter SIM op.
 * Registered once at startup. REAL submission paths are built by the
 * adapter from the same request shapes when a wallet is present.
 */
import { randomUUID } from "node:crypto";
import {
  deriveReputation,
  parseAgentId,
  parseProtocolEventId,
  parseReputationId,
} from "@bond/shared-types";
import {
  agentLifecycleOp,
  buildEnforcementRequest,
  lockBondOp,
  processEnforcementOp,
  readPublicState,
  registerAgentOp,
  releaseBondOp,
  withdrawBondOp,
} from "@bond/midnight-adapter";
import type { ChainHandle, OperationResult } from "@bond/midnight-adapter";
import type { ChainTxRow } from "../db/stores/chain.js";
import {
  findAgentById,
  findBondById,
  updateAgentStatus,
  updateBond,
} from "../db/stores/registry.js";
import {
  completeSlashEvent,
  insertSlashEvent,
  insertReputationRecord,
  listSlashEventsByAgent,
} from "../db/stores/attestation.js";
import { query } from "../db/pool.js";
import {
  registerPurposeExecutor,
  registerPurposeFinalizer,
} from "./transactions.js";
import { buildDecisionFromAttestation } from "./attestations.js";
import { recordEvent } from "./events.js";

async function agentOf(row: ChainTxRow) {
  if (!row.agent_id) {
    throw new Error("Transaction has no agent");
  }
  const agent = await findAgentById(row.agent_id);
  if (!agent) {
    throw new Error("Agent not found");
  }
  return agent;
}

/**
 * Seeds the SIMULATED adapter ledger from DB state when the agent is
 * absent there. Uses only the public read + register entrypoints; a
 * present agent is left untouched (idempotent).
 */
async function ensureSimulatedAgent(
  handle: ChainHandle,
  agentId: string,
  operatorId: string,
): Promise<void> {
  const views = await readPublicState(handle, { agentIds: [agentId] });
  if (views.length > 0) {
    return;
  }
  const result = registerAgentOp(handle, {
    kind: "register-agent",
    agentId,
    operatorId,
  });
  if (result.status !== "SUBMITTED") {
    throw new Error(`SIMULATED agent seed failed: ${result.errorCode}`);
  }
}

/**
 * Advances the SIMULATED ledger to FLAGGED for enforcement, replaying
 * only the lifecycle steps the ledger has not reached yet (observed via
 * public reads, never assumed).
 */
async function ensureSimulatedFlagged(
  handle: ChainHandle,
  input: {
    readonly agentId: string;
    readonly operatorId: string;
    readonly bondId: string;
    readonly commitmentMinorUnits: string;
  },
): Promise<void> {
  async function view() {
    const views = await readPublicState(handle, {
      agentIds: [input.agentId],
    });
    return views[0] ?? null;
  }
  let current = await view();
  if (!current) {
    await ensureSimulatedAgent(handle, input.agentId, input.operatorId);
    current = await view();
  }
  if (current?.bondStatus === null || current?.bondStatus === undefined) {
    const locked = lockBondOp(handle, {
      kind: "lock-bond",
      bondId: input.bondId,
      agentId: input.agentId,
      operatorId: input.operatorId,
      commitmentMinorUnits: input.commitmentMinorUnits,
    });
    if (locked.status !== "SUBMITTED") {
      throw new Error(`SIMULATED bond seed failed: ${locked.errorCode}`);
    }
    current = await view();
  }
  const step = async (name: "activate" | "flag") => {
    const result = await agentLifecycleOp(handle, name, {
      agentId: input.agentId,
      operatorId: input.operatorId,
    });
    if (result.status !== "SUBMITTED") {
      throw new Error(`SIMULATED ${name} failed: ${result.errorCode}`);
    }
  };
  if (current?.status === "BONDED") {
    await step("activate");
    current = await view();
  }
  if (current?.status === "ACTIVE") {
    await step("flag");
  }
}

export function registerBondExecutors(): void {
  registerPurposeExecutor(
    "REGISTRATION_ANCHOR",
    async (_handle: ChainHandle, row: ChainTxRow): Promise<OperationResult> => {
      const agent = await agentOf(row);
      return registerAgentOp(_handle, {
        kind: "register-agent",
        agentId: agent.id,
        operatorId: agent.operator_id,
      });
    },
  );
  registerPurposeExecutor(
    "FUND_BOND",
    async (_handle: ChainHandle, row: ChainTxRow): Promise<OperationResult> => {
      if (!row.bond_id) {
        throw new Error("Transaction has no bond");
      }
      const bond = await findBondById(row.bond_id);
      if (!bond) {
        throw new Error("Bond not found");
      }
      await ensureSimulatedAgent(_handle, bond.agent_id, bond.operator_id);
      return lockBondOp(_handle, {
        kind: "lock-bond",
        bondId: bond.id,
        agentId: bond.agent_id,
        operatorId: bond.operator_id,
        commitmentMinorUnits: bond.commitment_minor_units,
      });
    },
  );
  registerPurposeExecutor(
    "RELEASE_BOND",
    async (_handle: ChainHandle, row: ChainTxRow): Promise<OperationResult> => {
      if (!row.bond_id) {
        throw new Error("Transaction has no bond");
      }
      const bond = await findBondById(row.bond_id);
      if (!bond) {
        throw new Error("Bond not found");
      }
      return releaseBondOp(_handle, {
        bondId: bond.id,
        operatorId: bond.operator_id,
      });
    },
  );
  registerPurposeExecutor(
    "WITHDRAW",
    async (_handle: ChainHandle, row: ChainTxRow): Promise<OperationResult> => {
      if (!row.bond_id) {
        throw new Error("Transaction has no bond");
      }
      const bond = await findBondById(row.bond_id);
      if (!bond) {
        throw new Error("Bond not found");
      }
      return withdrawBondOp(_handle, {
        kind: "withdraw-bond",
        bondId: bond.id,
        operatorId: bond.operator_id,
      });
    },
  );
  registerPurposeExecutor(
    "ENFORCEMENT",
    async (_handle: ChainHandle, row: ChainTxRow): Promise<OperationResult> => {
      const params: { rows: { params: unknown }[] } = await query(
        "SELECT params FROM chain_transactions WHERE id = $1",
        [row.id],
      );
      const stored = (params.rows[0]?.params ?? {}) as {
        attestationId?: string;
        amountMinorUnits?: string;
      };
      if (!stored.attestationId) {
        throw new Error("ENFORCEMENT tx missing attestationId");
      }
      const { attestation, flag } = await buildDecisionFromAttestation(
        stored.attestationId,
      );
      const bond = row.bond_id ? await findBondById(row.bond_id) : null;
      if (!bond || !row.agent_id) {
        throw new Error("ENFORCEMENT tx missing bond/agent");
      }
      await ensureSimulatedFlagged(_handle, {
        agentId: row.agent_id,
        operatorId: bond.operator_id,
        bondId: bond.id,
        commitmentMinorUnits: bond.commitment_minor_units,
      });
      const request = buildEnforcementRequest({
        bondId: bond.id,
        attestation,
        flag,
        amountMinorUnits: stored.amountMinorUnits,
        nowIso: new Date().toISOString(),
      });
      return processEnforcementOp(_handle, request, new Date().toISOString());
    },
  );
}

async function refreshReputation(agentId: string): Promise<void> {
  const counts: {
    rows: {
      confirmed_flags: string;
      partial_slashes: string;
      full_slashes: string;
      clean_bonds: string;
    }[];
  } = await query(
    `SELECT
       (SELECT COUNT(*) FROM risk_flags WHERE agent_id = $1 AND status = 'attested') AS confirmed_flags,
       (SELECT COUNT(*) FROM slash_events WHERE agent_id = $1 AND is_full_slash = FALSE) AS partial_slashes,
       (SELECT COUNT(*) FROM slash_events WHERE agent_id = $1 AND is_full_slash = TRUE) AS full_slashes,
       (SELECT COUNT(*) FROM bonds WHERE agent_id = $1 AND status = 'WITHDRAWN') AS clean_bonds`,
    [agentId],
  );
  const c = counts.rows[0];
  if (!c) {
    return;
  }
  const record = deriveReputation({
    reputationId: parseReputationId(randomUUID()),
    agentId: parseAgentId(agentId),
    factors: {
      confirmedFlags: Number(c.confirmed_flags),
      partialSlashes: Number(c.partial_slashes),
      fullSlashes: Number(c.full_slashes),
      cleanBondsCompleted: Number(c.clean_bonds),
      remediatedResolutions: 0,
    },
    triggeredByEvent: parseProtocolEventId(randomUUID()),
    updatedAt: new Date().toISOString(),
  });
  await insertReputationRecord({
    id: record.reputationId as string,
    agentId,
    score: record.score,
    standing: record.standing,
    factors: record.factors,
    triggeredByEvent: record.triggeredByEvent as string,
    modelVersion: record.modelVersion,
    updatedAt: record.updatedAt,
  });
  await recordEvent({
    type: "REPUTATION_UPDATED",
    agentId,
    actor: "system:reputation",
    payload: { reputationId: record.reputationId, score: record.score },
  });
}

/** Mirror updates applied when a transaction CONFIRMS (chain already final). */
export function registerBondFinalizers(): void {
  registerPurposeFinalizer("FUND_BOND", async (row: ChainTxRow) => {
    if (!row.bond_id || !row.agent_id) {
      return;
    }
    await updateBond(row.bond_id, { status: "ACTIVE" });
    await updateAgentStatus(row.agent_id, "BONDED");
    await recordEvent({
      type: "BOND_STATUS_CHANGED",
      agentId: row.agent_id,
      bondId: row.bond_id,
      txId: row.id,
      actor: "system:worker",
      payload: { to: "ACTIVE" },
    });
  });
  registerPurposeFinalizer("ENFORCEMENT", async (row: ChainTxRow) => {
    const params: { rows: { params: unknown }[] } = await query(
      "SELECT params FROM chain_transactions WHERE id = $1",
      [row.id],
    );
    const stored = (params.rows[0]?.params ?? {}) as {
      attestationId?: string;
      decisionId?: string;
      flagId?: string;
      amountMinorUnits?: string;
      slashEventId?: string;
    };
    if (!row.bond_id || !row.agent_id) {
      return;
    }
    const bond = await findBondById(row.bond_id);
    if (!bond) {
      return;
    }
    const amount = stored.amountMinorUnits ?? "0";
    const remaining =
      BigInt(bond.commitment_minor_units) -
      BigInt(bond.slashed_total_minor_units);
    const slashed = amount === "FULL" ? remaining : BigInt(amount || "0");
    const total = BigInt(bond.slashed_total_minor_units) + slashed;
    const full = total >= BigInt(bond.commitment_minor_units);
    await updateBond(row.bond_id, {
      status: full ? "FULLY_SLASHED" : "PARTIALLY_SLASHED",
      slashedTotalMinorUnits: total.toString(),
    });
    await updateAgentStatus(row.agent_id, "SLASHED");
    const slashId = stored.slashEventId ?? randomUUID();
    const slashes = await listSlashEventsByAgent(row.agent_id, 100);
    const known = slashes.some((s) => s.id === slashId);
    if (!known) {
      if (!stored.flagId) {
        throw new Error("ENFORCEMENT finalizer missing flagId");
      }
      await insertSlashEvent({
        id: slashId,
        agentId: row.agent_id,
        bondId: row.bond_id,
        attestationId: stored.attestationId ?? "unknown",
        decisionId: stored.decisionId ?? stored.attestationId ?? "unknown",
        flagId: stored.flagId,
        category: "policy-violation",
        severity: full ? "critical" : "high",
        amountMinorUnits: slashed.toString(),
        isFullSlash: full,
        status: "initiated",
        txId: row.id,
        initiatedAt: new Date().toISOString(),
      });
    }
    await completeSlashEvent(slashId, new Date().toISOString());
    await recordEvent({
      type: "SLASH_COMPLETED",
      agentId: row.agent_id,
      bondId: row.bond_id,
      txId: row.id,
      actor: "system:worker",
      payload: { slashEventId: slashId, bondId: row.bond_id },
    });
    await refreshReputation(row.agent_id);
  });
  registerPurposeFinalizer("RELEASE_BOND", async (row: ChainTxRow) => {
    if (!row.bond_id) {
      return;
    }
    await updateBond(row.bond_id, { status: "WITHDRAWABLE" });
  });
  registerPurposeFinalizer("WITHDRAW", async (row: ChainTxRow) => {
    if (!row.bond_id || !row.agent_id) {
      return;
    }
    await updateBond(row.bond_id, {
      status: "WITHDRAWN",
      withdrawalConsumed: true,
    });
    await updateAgentStatus(row.agent_id, "WITHDRAWABLE");
    await refreshReputation(row.agent_id);
  });
}
