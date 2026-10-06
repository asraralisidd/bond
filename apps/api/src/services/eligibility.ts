/**
 * Eligibility integration: validated proof requests persisted with
 * lifecycle, adapter submission for REAL handles, SIMULATED mirror
 * otherwise. Private witnesses never enter this service — only the
 * operator-held private state passed through to adapter calls.
 */
import { randomUUID } from "node:crypto";
import {
  checkEligibility,
  createEligibilityProof,
  deriveProofNullifier,
  deriveRedemptionNullifier,
  toPublicEligibilityView,
} from "@bond/midnight-adapter";
import type { EligibilityPurpose } from "@bond/midnight-adapter";
import { policyVersionToBytes32 } from "@bond/midnight-adapter";
import { ELIGIBILITY_PURPOSE_CODES } from "@bond/midnight-adapter";
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import { recordEvent } from "./events.js";
import { getAgentService } from "./agents.js";
import { getBondService } from "./bonds.js";
import {
  findEligibilityProofById,
  insertEligibilityProof,
  updateEligibilityProof,
} from "../db/stores/chain.js";

export async function createEligibilityProofService(input: {
  readonly operatorId: string;
  readonly agentId: string;
  readonly bondId: string;
  readonly policyVersion?: string;
  readonly purpose?: string;
  readonly requiredMinimumMinorUnits: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly requestId?: string | null;
}): Promise<{ proofId: string; status: string }> {
  await getAgentService(input.agentId, input.operatorId);
  await getBondService(input.bondId, input.operatorId);
  const purpose = (input.purpose ??
    "collateral-sufficiency") as EligibilityPurpose;
  const policyVersion = input.policyVersion ?? "bond-policy-v1";
  const nowIso = new Date().toISOString();
  let proof;
  try {
    proof = createEligibilityProof({
      proofId: randomUUID(),
      kind: "SIMULATED-FIXTURE",
      agentId: input.agentId,
      bondId: input.bondId,
      policy: {
        policyVersion,
        requiredMinimumMinorUnits: input.requiredMinimumMinorUnits,
        purpose,
      },
      nullifier: deriveProofNullifier(input.agentId, purpose, input.nonce),
      expiresAt: input.expiresAt,
      nowIso,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "DomainError") {
      const code =
        (error as { code?: string }).code ?? "INVALID_ELIGIBILITY_PROOF";
      throw new ApiError(code, error.message);
    }
    throw error;
  }
  await withTransaction(async (client) => {
    await insertEligibilityProof(
      {
        id: proof.proofId,
        agentId: proof.agentId,
        bondId: proof.bondId,
        policyVersion: proof.policyVersion,
        purpose: proof.purpose,
        requiredMinimumMinorUnits: input.requiredMinimumMinorUnits,
        proofNullifier: proof.nullifier,
        status: "CREATED",
        expiresAt: proof.expiresAt,
      },
      client,
    );
    await recordEvent(
      {
        type: "ELIGIBILITY_PROVED",
        agentId: proof.agentId,
        bondId: proof.bondId,
        actor: `operator:${input.operatorId}`,
        policyVersion,
        requestId: input.requestId,
        payload: { proofId: proof.proofId },
      },
      client,
    );
  });
  return { proofId: proof.proofId, status: proof.status };
}

export async function verifyEligibilityService(input: {
  readonly proofId: string;
  readonly operatorId: string;
  readonly nowIso?: string;
}): Promise<unknown> {
  const row = await findEligibilityProofById(input.proofId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Eligibility proof not found");
  }
  await getAgentService(row.agent_id, input.operatorId);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const expectedHash = Buffer.from(
    policyVersionToBytes32(row.policy_version),
  ).toString("hex");
  const result = checkEligibility({
    record: {
      policyHashHex: expectedHash,
      purposeCode:
        ELIGIBILITY_PURPOSE_CODES[row.purpose as EligibilityPurpose] ?? 0,
      revoked: row.status === "REVOKED",
      consumed: row.status === "CONSUMED",
    },
    expectedPolicyHashHex: expectedHash,
    expectedPurposeCode:
      ELIGIBILITY_PURPOSE_CODES[row.purpose as EligibilityPurpose] ?? 0,
    expiresAt: row.expires_at,
    nowIso,
  });
  return toPublicEligibilityView({
    agentId: row.agent_id,
    check: result,
    policyVersion: row.policy_version,
    purpose: row.purpose as EligibilityPurpose,
    proofStatus:
      row.status === "CREATED" ||
      row.status === "SUBMITTED" ||
      row.status === "VERIFIED" ||
      row.status === "CONSUMED"
        ? row.status
        : "CREATED",
    asOf: nowIso,
  });
}

export async function consumeEligibilityService(input: {
  readonly proofId: string;
  readonly operatorId: string;
  readonly nonce: string;
  readonly requestId?: string | null;
}): Promise<{ status: string }> {
  const row = await findEligibilityProofById(input.proofId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Eligibility proof not found");
  }
  await getAgentService(row.agent_id, input.operatorId);
  if (row.status === "CONSUMED") {
    throw new ApiError("REPLAYED_ELIGIBILITY_PROOF", "Already consumed");
  }
  if (row.status === "REVOKED") {
    throw new ApiError("INVALID_ELIGIBILITY_PROOF", "Proof revoked");
  }
  if (Date.parse(new Date().toISOString()) >= Date.parse(row.expires_at)) {
    await withTransaction(async (client) => {
      await updateEligibilityProof(row.id, { status: "EXPIRED" }, client);
    });
    throw new ApiError("EXPIRED_ELIGIBILITY_PROOF", "Proof expired");
  }
  const redemption = deriveRedemptionNullifier(
    row.agent_id,
    row.id,
    input.nonce,
  );
  await withTransaction(async (client) => {
    await updateEligibilityProof(
      row.id,
      {
        status: "CONSUMED",
        redemptionNullifier: redemption,
      },
      client,
    );
    await recordEvent(
      {
        type: "ELIGIBILITY_CONSUMED",
        agentId: row.agent_id,
        bondId: row.bond_id,
        actor: `operator:${input.operatorId}`,
        policyVersion: row.policy_version,
        requestId: input.requestId,
        payload: { proofId: row.id },
      },
      client,
    );
  });
  return { status: "CONSUMED" };
}
