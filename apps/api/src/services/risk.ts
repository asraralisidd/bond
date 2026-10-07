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
 *
 * Phase 22 adds, inside the same transaction:
 *   - persisted agent policy overlays the caller-supplied context
 *     for governed fields (server authority; absent policy keeps
 *     caller context, preserving legacy behavior),
 *   - pure policy evaluation over usage windows aggregated from
 *     the ledger (server created_at, bounded exact COUNT/SUM),
 *   - policy findings scored under ruleset-v3/scoring-v3 and
 *     persisted as ordinary flags (observed risk → existing
 *     reputation hook; never verified outcomes).
 */
import {
  analyzeActivity,
  deriveEvidence,
  evaluateBehavioral,
  normalizeActivity,
  scoreWithBehavioral,
  scoreWithPolicy,
  toEvidenceRef,
} from "@bond/risk-engine";
import type {
  BehavioralHistory,
  LedgerActivityEntry,
  RawActivityInput,
  RuleFinding,
} from "@bond/risk-engine";
import {
  behavioralScorerVersionString,
  policyScorerVersionString,
} from "@bond/risk-engine";
import {
  RULE_SET_V2,
  RULE_SET_V3,
  SCORING_V2,
  SCORING_V3,
} from "@bond/risk-engine";
import { evaluatePolicy, POLICY_VERSION } from "@bond/policy-engine";
import type { PolicyDecision, PolicyUsageWindow } from "@bond/policy-engine";
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
import type { PoolClient } from "pg";
import { updateAgentStatus } from "../db/stores/registry.js";
import { recordEvent } from "./events.js";
import { applyReputationEventService } from "./reputation.js";
import { getActivePolicyForAnalysis, policyVersionLabel } from "./policies.js";
import type { ResolvedAgentPolicy } from "@bond/policy-engine";
import {
  findRiskAnalysisById,
  insertEvidenceDescriptor,
  insertLedgerActivity,
  insertRiskAnalysis,
  insertRiskFlag,
  listLedgerWindow,
  listRecentFlagsForBehavior,
  purgeOldLedgerEntries,
  sumLedgerUsage,
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

/**
 * Overlays persisted policy fields onto the caller-supplied context.
 * Persisted allowlists/caps win when set; denies are monotonic (a
 * client cannot un-deny what policy forbids):
 * - allowedActions: persisted allow, else client minus persisted denies
 * - declaredTools: persisted allow, else client minus persisted denies
 *   (empty-declared fallback when the client declares nothing: with
 *   an active policy, tool use must be declared to be evaluated)
 * - denylistedActions: union of persisted and client denies
 * - spendLimit: persisted transfer cap, else client limit
 * Returns the input unchanged when no persisted policy exists
 * (legacy behavior preserved exactly).
 */
function withEffectivePolicyContext(
  activity: Omit<RawActivityInput, "agentId">,
  persisted: ResolvedAgentPolicy | null,
): Omit<RawActivityInput, "agentId"> {
  if (persisted === null) {
    return activity;
  }
  const client = activity.policyContext;
  return {
    ...activity,
    policyContext: {
      ...client,
      allowedActions:
        persisted.allowedActions ??
        subtractList(client.allowedActions, persisted.deniedActions),
      declaredTools:
        persisted.allowedTools ??
        subtractList(client.declaredTools, persisted.deniedTools) ??
        (persisted.deniedTools.length > 0 ? [] : client.declaredTools),
      denylistedActions: unionLists(
        persisted.deniedActions,
        client.denylistedActions,
      ),
      spendLimitMinorUnits:
        persisted.maxTransferMinorUnits ?? client.spendLimitMinorUnits,
    },
  };
}

function subtractList(
  client: readonly string[] | undefined,
  denied: readonly string[],
): readonly string[] | undefined {
  if (client === undefined) {
    return undefined;
  }
  const deniedSet = new Set(denied);
  return client.filter((entry) => !deniedSet.has(entry));
}

function unionLists(
  persisted: readonly string[],
  client: readonly string[] | undefined,
): readonly string[] | undefined {
  const merged = [...new Set([...persisted, ...(client ?? [])])];
  return merged.length === 0 ? undefined : merged;
}

function toMs(value: unknown): number {
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
}

const EMPTY_POLICY_USAGE: PolicyUsageWindow = {
  requestCount: 0,
  totalTokens: "0",
  totalCostMinorUnits: "0",
};

/**
 * Aggregates server-side usage over the policy-configured windows.
 * One exact aggregate query per active window (indexed range scan
 * on created_at); windows without configured limits are skipped.
 * Counts/queries never use client timestamps.
 */
async function loadPolicyUsage(
  agentId: string,
  persisted: ResolvedAgentPolicy | null,
  nowMs: number,
  client: PoolClient,
): Promise<PolicyUsageWindow> {
  if (persisted === null) {
    return EMPTY_POLICY_USAGE;
  }
  const since = (seconds: number): string =>
    new Date(nowMs - seconds * 1000).toISOString();
  const [requests, tokens, cost] = await Promise.all([
    persisted.maxRequestsPerWindow !== null &&
    persisted.requestWindowSeconds !== null
      ? sumLedgerUsage(agentId, since(persisted.requestWindowSeconds), client)
      : null,
    persisted.maxTotalTokensPerWindow !== null &&
    persisted.tokenWindowSeconds !== null
      ? sumLedgerUsage(agentId, since(persisted.tokenWindowSeconds), client)
      : null,
    persisted.maxCostMinorUnitsPerWindow !== null &&
    persisted.costWindowSeconds !== null
      ? sumLedgerUsage(agentId, since(persisted.costWindowSeconds), client)
      : null,
  ]);
  return {
    requestCount: requests?.requestCount ?? 0,
    totalTokens: tokens?.totalTokens ?? "0",
    totalCostMinorUnits: cost?.totalCostMinorUnits ?? "0",
  };
}

export interface PolicyDecisionDto {
  readonly allowed: boolean;
  readonly policyVersion: string;
  readonly source: "agent-policy" | "none";
  readonly violations: readonly {
    readonly ruleId: string;
    readonly severity: string;
    readonly category: string;
    readonly reasonCode: string;
    readonly observed: string;
    readonly limit: string;
    readonly explanation: string;
  }[];
}

export async function analyzeActivityService(
  input: AnalyzeActivityInput,
): Promise<{
  analysisId: string;
  flagIds: string[];
  score: unknown;
  policy: PolicyDecisionDto;
}> {
  const agent = await getAgentService(input.agentId, input.operatorId);
  // Persisted policy (if any) governs: its fields override the
  // caller-supplied context so agents cannot self-authorize by
  // submitting permissive contexts. Absent policy keeps caller
  // context — legacy behavior, unchanged.
  const persistedPolicy = await getActivePolicyForAnalysis(input.agentId);
  const effectiveActivity = withEffectivePolicyContext(
    input.activity,
    persistedPolicy,
  );
  let result;
  try {
    result = analyzeActivity(
      { ...effectiveActivity, agentId: input.agentId },
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
  // it needs no connection and must never hold one. Behavioral and
  // policy evaluation are equally pure — history arrives as data,
  // loaded inside the transaction below.
  const normalized = normalizeActivity({
    ...effectiveActivity,
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

  let outcome: {
    analysisId: string;
    flagIds: string[];
    score: unknown;
    policy: PolicyDecisionDto;
  };
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
      const behavioralScore = scoreWithBehavioral(result.score, behavioral);
      const hasBehavioral = behavioral.length > 0;
      // Phase 22: pure policy evaluation over server-aggregated
      // usage windows (exact COUNT/SUM on created_at, bounded by
      // policy-configured windows). No persisted policy → no
      // evaluation (v1 rules already judged the caller context).
      const policyLabel =
        persistedPolicy === null
          ? normalized.policyContext.policyVersion
          : policyVersionLabel(persistedPolicy.version);
      const policyUsage = await loadPolicyUsage(
        input.agentId,
        persistedPolicy,
        nowMs,
        client,
      );
      const decision: PolicyDecision = evaluatePolicy({
        activity: {
          provider: normalized.provider,
          model: normalized.model,
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          totalTokens: normalized.totalTokens,
          costMinorUnits: normalized.estimatedCostMinorUnits,
        },
        policy: persistedPolicy,
        usage: policyUsage,
        policyVersion: policyLabel,
      });
      const policyFindings: RuleFinding[] = decision.violations.map(
        (violation) => ({
          ruleId: violation.ruleId,
          analyzerKind: "rule-based",
          category: violation.category,
          severity: violation.severity,
          confidence: violation.confidence,
          explanation: {
            what: violation.explanation,
            whyItMatters: `Agent policy ${decision.policyVersion} governs this operational constraint; exceeding it moves outside the authorized envelope.`,
            ruleId: violation.ruleId,
            ruleVersion: POLICY_VERSION,
          },
          evidence,
        }),
      );
      const finalScore = scoreWithPolicy(behavioralScore, policyFindings);
      const hasPolicy = policyFindings.length > 0;
      await insertRiskAnalysis(
        {
          id: result.analysisId,
          agentId: input.agentId,
          engineVersion: result.engineVersion,
          rulesetVersion: hasPolicy
            ? RULE_SET_V3
            : hasBehavioral
              ? RULE_SET_V2
              : result.ruleSetVersion,
          scoringVersion: hasPolicy
            ? SCORING_V3
            : hasBehavioral
              ? SCORING_V2
              : result.scoringVersion,
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
      const policyFlags: RiskFlag[] = policyFindings.map((item) =>
        createRiskFlag({
          riskFlagId: parseRiskFlagId(`rf-${evidence.digest}-${item.ruleId}`),
          agentId: parseAgentId(input.agentId),
          category: item.category,
          severity: item.severity,
          confidence: item.confidence / 100,
          evidenceRefs: [toEvidenceRef(evidence)],
          detectedAt: normalized.occurredAt,
          modelVersion: policyScorerVersionString(),
        }),
      );
      const flagIds: string[] = [];
      for (const flag of [
        ...result.flags,
        ...behavioralFlags,
        ...policyFlags,
      ]) {
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
          provider: normalized.provider,
          model: normalized.model,
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          totalTokens: normalized.totalTokens,
          costMinorUnits: normalized.estimatedCostMinorUnits,
        },
        client,
      );
      if (decision.violations.length > 0) {
        await recordEvent(
          {
            type: "POLICY_VIOLATION",
            agentId: input.agentId,
            actor: "system:policy-engine",
            requestId: input.requestId,
            payload: {
              policyVersion: decision.policyVersion,
              ruleIds: decision.violations.map((v) => v.ruleId),
            },
          },
          client,
        );
      }
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
      return {
        analysisId: result.analysisId,
        flagIds,
        score: finalScore,
        policy: {
          allowed: decision.allowed,
          policyVersion: decision.policyVersion,
          source: persistedPolicy === null ? "none" : "agent-policy",
          violations: decision.violations.map((violation) => ({
            ruleId: violation.ruleId,
            severity: violation.severity,
            category: violation.category,
            reasonCode: violation.reasonCode,
            observed: violation.observed,
            limit: violation.limit,
            explanation: violation.explanation,
          })),
        } satisfies PolicyDecisionDto,
      };
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
