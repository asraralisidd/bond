/**
 * Attestor integration: runs attestor evaluation as pure functions over
 * persisted flags, stores attestation records, and exposes explicit
 * enforcement-intent creation. Attestors never submit transactions —
 * enforcement goes through transaction intents like everything else.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  createAttestationRequest,
  issueDecision,
  parseAgentId,
  parseAttestationId,
  parseAttestorId,
  parseDecisionId,
  parseEvidenceId,
  parseRiskFlagId,
  recordVerdict,
} from "@bond/shared-types";
import { createAttestor } from "@bond/attestor";
import { evaluateIndependently } from "@bond/attestor";
import type {
  Attestation,
  AttestationStatus,
  AttestationVerdict,
  AttestationVerdictRecord,
  EvidenceCategory,
  RiskFlag,
  RiskFlagStatus,
} from "@bond/shared-types";
import { ApiError } from "../http/errors.js";
import { recordEvent } from "./events.js";
import {
  findAttestationById,
  findAttestorById,
  insertAttestation,
  updateAttestation,
  upsertAttestor,
} from "../db/stores/attestation.js";
import { findRiskFlagById, updateRiskFlagStatus } from "../db/stores/risk.js";
import { query } from "../db/pool.js";

export function hashAttestorSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export async function registerAttestorService(input: {
  readonly operatorId: string;
  readonly attestorId?: string;
  readonly organization: string;
  readonly secret: string;
}): Promise<{ attestorId: string }> {
  if (
    !input.organization?.trim() ||
    !input.secret ||
    input.secret.length < 16
  ) {
    throw new ApiError(
      "INVALID_IDENTIFIER",
      "organization and secret (16+ chars) required",
    );
  }
  const id = input.attestorId?.trim() || randomUUID();
  await upsertAttestor({
    id,
    organization: input.organization.trim(),
    status: "active",
  });
  await query(
    `INSERT INTO attestor_credentials (attestor_id, secret_hash)
     VALUES ($1, $2)
     ON CONFLICT (attestor_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash`,
    [id, hashAttestorSecret(input.secret)],
  );
  return { attestorId: id };
}

export async function checkAttestorSecret(
  attestorId: string,
  secret: string | undefined,
): Promise<void> {
  if (!secret) {
    throw new ApiError("UNAUTHORIZED", "Attestor credential required");
  }
  const result: { rows: { secret_hash: string }[] } = await query(
    "SELECT secret_hash FROM attestor_credentials WHERE attestor_id = $1",
    [attestorId],
  );
  const row = result.rows[0];
  if (!row || row.secret_hash !== hashAttestorSecret(secret)) {
    throw new ApiError("UNAUTHORIZED", "Invalid attestor credential");
  }
  const attestor = await findAttestorById(attestorId);
  if (!attestor || attestor.status !== "active") {
    throw new ApiError("FORBIDDEN", "Attestor not eligible");
  }
}

function toDomainAttestation(row: {
  id: string;
  flag_id: string;
  agent_id: string;
  threshold: number;
  policy_version: string;
  verdicts: unknown;
  status: string;
  decision: unknown;
  requested_at: string;
  expires_at: string;
}): Attestation {
  return {
    attestationId: parseAttestationId(row.id),
    riskFlagId: parseRiskFlagId(row.flag_id),
    agentId: parseAgentId(row.agent_id),
    evidenceRefs: [],
    policyVersion: row.policy_version,
    threshold: row.threshold,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    verdicts: row.verdicts as AttestationVerdictRecord[],
    status: row.status as AttestationStatus,
    decision: row.decision as Attestation["decision"],
  };
}

async function buildDomainFlag(flagId: string): Promise<RiskFlag> {
  const flag = await findRiskFlagById(flagId);
  if (!flag) {
    throw new ApiError("NOT_FOUND", "Risk flag not found");
  }
  const evidenceRows: {
    rows: { id: string; content_hash: string; category: string }[];
  } = await query(
    `SELECT id, content_hash, category FROM evidence_descriptors
       WHERE agent_id = $1`,
    [flag.agent_id],
  );
  const byId = new Map(evidenceRows.rows.map((r) => [r.id, r]));
  const evidenceRefs = (flag.evidence_ids as string[]).map((id) => {
    const descriptor = byId.get(id);
    return {
      evidenceId: parseEvidenceId(id),
      category: (descriptor?.category ?? "human-report") as EvidenceCategory,
      contentHash: descriptor?.content_hash ?? `missing:${id}`,
    };
  });
  const detected: { rows: { detected_at: string }[] } = await query(
    'SELECT to_char(detected_at, \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS detected_at FROM risk_flags WHERE id = $1',
    [flagId],
  );
  return {
    riskFlagId: parseRiskFlagId(flag.id),
    agentId: parseAgentId(flag.agent_id),
    category: flag.category as RiskFlag["category"],
    severity: flag.severity as RiskFlag["severity"],
    confidence: flag.confidence,
    evidenceRefs,
    detectedAt: detected.rows[0]?.detected_at ?? new Date().toISOString(),
    modelVersion: flag.model_version,
    status: flag.status as RiskFlagStatus,
    supersedes: flag.supersedes as RiskFlag["supersedes"],
  };
}

export async function requestAttestationService(input: {
  readonly operatorId: string;
  readonly flagId: string;
  readonly attestorIds: readonly string[];
  readonly threshold?: number;
  readonly expiresAt: string;
  readonly requestId?: string | null;
}): Promise<{ attestationId: string; status: string }> {
  const flag = await findRiskFlagById(input.flagId);
  if (!flag) {
    throw new ApiError("NOT_FOUND", "Risk flag not found");
  }
  if (input.attestorIds.length === 0) {
    throw new ApiError("INVALID_IDENTIFIER", "At least one attestor required");
  }
  const threshold = input.threshold ?? 2;
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  createAttestationRequest({
    attestationId: parseAttestationId(id),
    riskFlagId: parseRiskFlagId(flag.id),
    agentId: parseAgentId(flag.agent_id),
    evidenceRefs: (flag.evidence_ids as string[]).map((e) =>
      parseEvidenceId(e),
    ),
    policyVersion: "bond-policy-v1",
    threshold,
    requestedAt: nowIso,
    expiresAt: input.expiresAt,
  });
  await insertAttestation({
    id,
    flagId: flag.id,
    agentId: flag.agent_id,
    threshold,
    policyVersion: "bond-policy-v1",
    status: "requested",
    requestedAt: nowIso,
    expiresAt: input.expiresAt,
  });
  await recordEvent({
    type: "ATTESTATION_ISSUED",
    agentId: flag.agent_id,
    actor: `operator:${input.operatorId}`,
    requestId: input.requestId,
    payload: { attestationId: id, riskFlagId: flag.id },
  });
  return { attestationId: id, status: "requested" };
}

export async function submitVerdictService(input: {
  readonly attestationId: string;
  readonly attestorId: string;
  readonly verdict: AttestationVerdict;
  readonly secret: string | undefined;
  readonly issuedAt?: string;
  readonly requestId?: string | null;
}): Promise<{ status: string; verdicts: number }> {
  await checkAttestorSecret(input.attestorId, input.secret);
  const row = await findAttestationById(input.attestationId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  if (!["confirm", "reject", "abstain"].includes(input.verdict)) {
    throw new ApiError("INVALID_IDENTIFIER", "Invalid verdict");
  }
  const attestation = toDomainAttestation(row);
  let updated: Attestation;
  try {
    updated = recordVerdict(attestation, {
      attestorId: parseAttestorId(input.attestorId),
      verdict: input.verdict,
      bindingRef: `binding:${row.id}:${input.attestorId}`,
      issuedAt: input.issuedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "DomainError") {
      const code = (error as { code?: string }).code ?? "INVALID_ATTESTATION";
      throw new ApiError(code, error.message);
    }
    throw error;
  }
  await updateAttestation(row.id, {
    verdicts: updated.verdicts,
    status: updated.status,
    decision: updated.decision,
  });
  await recordEvent({
    type: "ATTESTATION_RECORDED",
    agentId: row.agent_id,
    actor: `attestor:${input.attestorId}`,
    requestId: input.requestId,
    payload: { attestationId: row.id, verdict: input.verdict },
  });
  return { status: updated.status, verdicts: updated.verdicts.length };
}

export async function autoEvaluateService(input: {
  readonly attestationId: string;
  readonly operatorId: string;
  readonly strictness?: number;
  readonly requestId?: string | null;
}): Promise<{ status: string; evaluations: string[] }> {
  const row = await findAttestationById(input.attestationId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  const domainFlag = await buildDomainFlag(row.flag_id);
  const available = new Set(
    domainFlag.evidenceRefs.map((r) => r.evidenceId as string),
  );
  const registered: { rows: { id: string }[] } = await query(
    "SELECT id FROM attestors WHERE status = 'active' LIMIT 10",
  );
  const strictness =
    input.strictness === 1 || input.strictness === -1 ? input.strictness : 0;
  const outcomes: string[] = [];
  let attestation = toDomainAttestation(row);
  for (const candidate of registered.rows) {
    const profile = {
      attestor: createAttestor({
        attestorId: candidate.id,
        organization: "auto",
        registeredAt: new Date().toISOString(),
      }),
      strictness: strictness as -1 | 0 | 1,
    };
    const evaluation = evaluateIndependently(
      profile,
      domainFlag,
      available,
      new Date().toISOString(),
    );
    outcomes.push(`${candidate.id}:${evaluation.outcome}`);
    try {
      attestation = recordVerdict(attestation, {
        attestorId: parseAttestorId(candidate.id),
        verdict: evaluation.verdict,
        bindingRef: `binding:${row.id}:${candidate.id}`,
        issuedAt: new Date().toISOString(),
      });
    } catch {
      break;
    }
  }
  await updateAttestation(row.id, {
    verdicts: attestation.verdicts,
    status: attestation.status,
    decision: attestation.decision,
  });
  await updateRiskFlagStatus(
    row.flag_id,
    attestation.status === "rejected" ? "dismissed" : "under-review",
  );
  return { status: attestation.status, evaluations: outcomes };
}

export async function issueDecisionService(input: {
  readonly attestationId: string;
  readonly operatorId: string;
  readonly action?: "partial-slash" | "full-slash" | "dismiss";
  readonly requestId?: string | null;
}): Promise<{ status: string; action: string | null }> {
  const row = await findAttestationById(input.attestationId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  if (row.status !== "quorum-met") {
    throw new ApiError("INVALID_ATTESTATION", "Quorum not met");
  }
  const flag = await findRiskFlagById(row.flag_id);
  const action =
    input.action ??
    (flag?.severity === "critical" ? "full-slash" : "partial-slash");
  if (action === "dismiss") {
    throw new ApiError("INVALID_ATTESTATION", "Dismiss carries no enforcement");
  }
  const nowIso = new Date().toISOString();
  const decided = issueDecision(toDomainAttestation(row), {
    decisionId: parseDecisionId(`dec-${row.id}`),
    action,
    nullifier: `bond-nullifier:${row.id}:${row.flag_id}`,
    decisionExpiresAt: row.expires_at,
    nowIso,
  });
  await updateAttestation(row.id, {
    verdicts: decided.verdicts,
    status: decided.status,
    decision: decided.decision,
  });
  await updateRiskFlagStatus(row.flag_id, "attested");
  await recordEvent({
    type: "DECISION_ISSUED",
    agentId: row.agent_id,
    actor: `operator:${input.operatorId}`,
    requestId: input.requestId,
    payload: { attestationId: row.id, action },
  });
  return { status: decided.status, action };
}

export async function getAttestationService(id: string): Promise<unknown> {
  const row = await findAttestationById(id);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  return {
    attestationId: row.id,
    flagId: row.flag_id,
    agentId: row.agent_id,
    threshold: row.threshold,
    policyVersion: row.policy_version,
    verdicts: row.verdicts,
    status: row.status,
    decision: row.decision,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
  };
}

export async function buildDecisionFromAttestation(
  attestationId: string,
): Promise<{
  attestation: Attestation;
  flag: RiskFlag;
}> {
  const row = await findAttestationById(attestationId);
  if (!row) {
    throw new ApiError("NOT_FOUND", "Attestation not found");
  }
  const attestation = toDomainAttestation(row);
  const flag = await buildDomainFlag(row.flag_id);
  return { attestation, flag };
}
