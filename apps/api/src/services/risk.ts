/**
 * Risk integration: runs the Risk Engine as a pure function over
 * validated input, then persists the analysis, evidence descriptors,
 * and flags. The engine never sees sockets, DB handles, or wallets —
 * it receives data and returns data.
 */
import { analyzeActivity } from "@bond/risk-engine";
import type { RawActivityInput } from "@bond/risk-engine";
import { randomUUID } from "node:crypto";
import { getAgentService, transitionAgentService } from "./agents.js";
import { ApiError } from "../http/errors.js";
import { recordEvent } from "./events.js";
import {
  insertEvidenceDescriptor,
  insertRiskAnalysis,
  insertRiskFlag,
} from "../db/stores/risk.js";

export interface AnalyzeActivityInput {
  readonly operatorId: string;
  readonly agentId: string;
  readonly activity: Omit<RawActivityInput, "agentId">;
  readonly requestId?: string | null;
}

export async function analyzeActivityService(
  input: AnalyzeActivityInput,
): Promise<{
  analysisId: string;
  flagIds: string[];
  score: unknown;
}> {
  const agent = await getAgentService(input.agentId, input.operatorId);
  let result;
  try {
    result = analyzeActivity(
      { ...input.activity, agentId: input.agentId },
      { requestId: input.requestId ?? undefined },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "DomainError") {
      const code =
        (error as { code?: string }).code ?? "INVALID_ACTIVITY_INPUT";
      throw new ApiError(code, error.message);
    }
    throw error;
  }
  await insertRiskAnalysis({
    id: result.analysisId,
    agentId: input.agentId,
    engineVersion: result.engineVersion,
    rulesetVersion: result.ruleSetVersion,
    scoringVersion: result.scoringVersion,
    score: result.score,
    requestId: input.requestId,
  });
  const flagIds: string[] = [];
  for (const flag of result.flags) {
    for (const ref of flag.evidenceRefs) {
      await insertEvidenceDescriptor({
        id: `ev_${randomUUID()}`,
        agentId: input.agentId,
        contentHash: ref.contentHash,
        category: ref.category,
        storageRef: null,
        submittedBy: `operator:${input.operatorId}`,
        submittedAt: flag.detectedAt,
      });
    }
    await insertRiskFlag({
      id: flag.riskFlagId as string,
      agentId: input.agentId,
      analysisId: result.analysisId,
      category: flag.category,
      severity: flag.severity,
      confidence: flag.confidence,
      evidenceIds: flag.evidenceRefs.map((r) => r.evidenceId as string),
      modelVersion: flag.modelVersion,
      status: flag.status,
      supersedes: flag.supersedes as string | null,
      detectedAt: flag.detectedAt,
    });
    flagIds.push(flag.riskFlagId as string);
    await recordEvent({
      type: "RISK_FLAG_RAISED",
      agentId: input.agentId,
      actor: "system:risk-engine",
      requestId: input.requestId,
      payload: { riskFlagId: flag.riskFlagId, severity: flag.severity },
    });
  }
  if (flagIds.length > 0 && agent.status === "ACTIVE") {
    await transitionAgentService(
      input.agentId,
      input.operatorId,
      "FLAGGED",
      input.requestId,
    );
  }
  return { analysisId: result.analysisId, flagIds, score: result.score };
}

export function toScoreDto(score: unknown): unknown {
  if (score === null || score === undefined) {
    return null;
  }
  const s = score as {
    score?: number;
    severity?: string;
    confidence?: number;
    factors?: unknown;
  };
  return {
    score: s.score,
    severity: s.severity,
    confidence: s.confidence,
    factors: s.factors,
  };
}
