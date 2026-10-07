/**
 * Risk integration: runs the Risk Engine as a pure function over
 * validated input, then persists the analysis, evidence descriptors,
 * flags, and the Phase 20 activity-ledger row. The engine never sees
 * sockets, DB handles, or wallets — it receives data and returns data.
 *
 * Phase 20 ordering (single transaction, all-or-nothing):
 *   1. replay pre-check (existing analysis id → REPLAYED_ACTIVITY)
 *   2. bounded history load (ledger window + recent flags, agent-scoped)
 *   3. pure behavioral evaluation over (current + history)
 *   4. single analysis insert with FINAL score/versions
 *   5. flag inserts (v1 + behavioral), ledger insert (idempotent),
 *      events, agent status
 * A concurrent duplicate that passes the pre-check fails on the
 * analysis PK; unique violations map to REPLAYED_ACTIVITY as well.
 */
import {
  analyzeActivity,
  deriveEvidence,
  evaluateBehavioral,
  normalizeActivity,
  scoreWithBehavioral,
  toEvidenceRef,
} from "@bond/risk-engine";
import type {
  BehavioralHistory,
  LedgerActivityEntry,
  RawActivityInput,
} from "@bond/risk-engine";
import { behavioralScorerVersionString } from "@bond/risk-engine";
import { RULE_SET_V2, SCORING_V2 } from "@bond/risk-engine";
import { randomUUID } from "node:crypto";
import {
  createRiskFlag,
  parseAgentId,
  parseRiskFlagId,
  transitionAgentStatus,
} from "@bond/shared-types";
import type { AgentStatus, RiskCategory, RiskFlag } from "@bond/shared-types";
import { getAgentService } from "./agents.js";
import { ApiError } from "../http/errors.js";
import { withTransaction } from "../db/pool.js";
import { updateAgentStatus } from "../db/stores/registry.js";
import { recordEvent } from "./events.js";
import { applyReputationEventService } from "./reputation.js";
import {
  findRiskAnalysisById,
  insertEvidenceDescriptor,
  insertLedgerActivity,
  insertRiskAnalysis,
  insertRiskFlag,
  listLedgerWindow,
  listRecentFlagsForBehavior,
  purgeOldLedgerEntries,
} from "../db/stores/risk.js";

/** Hard bound on every behavioral history load. */
const BEHAVIORAL_WINDOW_LIMIT = 500;
/** Ledger retention for opportunistic purge (days). */
const LEDGER_RETENTION_DAYS = 90;
const LEDGER_PURGE_BATCH = 1000;
const MS_PER_HOUR = 3_600_000;

export interface AnalyzeActivityInput {
  readonly operatorId: string;
  readonly agentId: string;
  readonly activity: Omit<RawActivityInput, "agentId">;
  readonly requestId?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function toMs(value: unknown): number {
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
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
  // Pure engine execution happens OUTSIDE any database transaction:
  // it needs no connection and must never hold one. Behavioral
  // evaluation is equally pure — history arrives as data, loaded
  // inside the transaction below.
  const normalized = normalizeActivity({
    ...input.activity,
    agentId: input.agentId,
  });
  const evidence = deriveEvidence(normalized);
  const nowMs = Date.now();
  const thresholds = normalized.policyContext.behavioralThresholds;
  const maxWindowMs =
    Math.max(
      thresholds.windowHours,
      thresholds.repeatWindowHours,
      thresholds.baselineDays * 24,
    ) * MS_PER_HOUR;
  const windowCutoffIso = new Date(nowMs - maxWindowMs).toISOString();
  const current: LedgerActivityEntry = {
    analysisId: result.analysisId,
    action: normalized.action,
    tool: normalized.tool,
    amountMinorUnits: normalized.amountMinorUnits,
    createdAtMs: nowMs,
  };

  let outcome: { analysisId: string; flagIds: string[]; score: unknown };
  try {
    outcome = await withTransaction(async (client) => {
      const replay = await findRiskAnalysisById(result.analysisId, client);
      if (replay !== null) {
        throw new ApiError(
          "REPLAYED_ACTIVITY",
          "Activity was already analyzed",
        );
      }
      const [ledgerRows, flagRows] = await Promise.all([
        listLedgerWindow(
          input.agentId,
          windowCutoffIso,
          BEHAVIORAL_WINDOW_LIMIT,
          client,
        ),
        listRecentFlagsForBehavior(
          input.agentId,
          windowCutoffIso,
          BEHAVIORAL_WINDOW_LIMIT,
          client,
        ),
      ]);
      const history: BehavioralHistory = {
        entries: ledgerRows.map((row) => ({
          analysisId: row.analysis_id,
          action: row.action,
          tool: row.tool,
          amountMinorUnits: row.amount_minor_units,
          createdAtMs: toMs(row.created_at),
        })),
        priorFlags: flagRows.map((row) => ({
          category: row.category as RiskCategory,
          status: row.status,
          createdAtMs: toMs(row.created_at),
        })),
      };
      const behavioral = evaluateBehavioral(
        normalized,
        evidence,
        current,
        history,
        result.findings.map((finding) => finding.category),
        nowMs,
      );
      const finalScore = scoreWithBehavioral(result.score, behavioral);
      const hasBehavioral = behavioral.length > 0;
      await insertRiskAnalysis(
        {
          id: result.analysisId,
          agentId: input.agentId,
          engineVersion: result.engineVersion,
          rulesetVersion: hasBehavioral ? RULE_SET_V2 : result.ruleSetVersion,
          scoringVersion: hasBehavioral ? SCORING_V2 : result.scoringVersion,
          score: finalScore,
          requestId: input.requestId,
        },
        client,
      );
      const behavioralFlags: RiskFlag[] = behavioral.map((item) =>
        createRiskFlag({
          riskFlagId: parseRiskFlagId(`rf-${evidence.digest}-${item.ruleId}`),
          agentId: parseAgentId(input.agentId),
          category: item.category,
          severity: item.severity,
          confidence: item.confidence / 100,
          evidenceRefs: [toEvidenceRef(evidence)],
          detectedAt: normalized.occurredAt,
          modelVersion: behavioralScorerVersionString(),
        }),
      );
      const flagIds: string[] = [];
      for (const flag of [...result.flags, ...behavioralFlags]) {
        for (const ref of flag.evidenceRefs) {
          await insertEvidenceDescriptor(
            {
              id: `ev_${randomUUID()}`,
              agentId: input.agentId,
              contentHash: ref.contentHash,
              category: ref.category,
              storageRef: null,
              submittedBy: `operator:${input.operatorId}`,
              submittedAt: flag.detectedAt,
            },
            client,
          );
        }
        await insertRiskFlag(
          {
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
          },
          client,
        );
        flagIds.push(flag.riskFlagId as string);
        await recordEvent(
          {
            type: "RISK_FLAG_RAISED",
            agentId: input.agentId,
            actor: "system:risk-engine",
            requestId: input.requestId,
            payload: { riskFlagId: flag.riskFlagId, severity: flag.severity },
          },
          client,
        );
        // Observed risk only: a raw flag is NOT a confirmed violation,
        // so its reputation weight stays small by policy. Same tx —
        // the flag and its reputation effect commit together.
        await applyReputationEventService(
          {
            agentId: input.agentId,
            eventType: "risk_flag_observed",
            sourceType: "risk_flag",
            sourceId: flag.riskFlagId as string,
            severity: flag.severity,
            category: flag.category,
            requestId: input.requestId,
          },
          client,
        );
      }
      // Ledger write is idempotent (ON CONFLICT DO NOTHING): a replay
      // that reaches this point cannot duplicate behavioral state.
      await insertLedgerActivity(
        {
          analysisId: result.analysisId,
          agentId: input.agentId,
          actionType: normalized.actionType,
          action: normalized.action,
          tool: normalized.tool,
          amountMinorUnits: normalized.amountMinorUnits,
          bytesOut: normalized.bytesOut,
          occurredAt: normalized.occurredAt,
        },
        client,
      );
      if (flagIds.length > 0 && agent.status === "ACTIVE") {
        const next = transitionAgentStatus(
          agent.status as AgentStatus,
          "FLAGGED",
        );
        await updateAgentStatus(input.agentId, next, client);
        await recordEvent(
          {
            type: "AGENT_STATUS_CHANGED",
            agentId: input.agentId,
            actor: "system:risk-engine",
            requestId: input.requestId,
            payload: { from: agent.status, to: next },
          },
          client,
        );
      }
      return { analysisId: result.analysisId, flagIds, score: finalScore };
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Lost a concurrent duplicate race on the analysis PK.
    if (isUniqueViolation(error)) {
      throw new ApiError("REPLAYED_ACTIVITY", "Activity was already analyzed");
    }
    throw error;
  }
  // Opportunistic retention: bounded, best-effort, never fails analysis.
  try {
    await purgeOldLedgerEntries(LEDGER_RETENTION_DAYS, LEDGER_PURGE_BATCH);
  } catch {
    // Cleanup must never break analysis.
  }
  return outcome;
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
