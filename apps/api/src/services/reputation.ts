/**
 * Phase 21 reputation application service.
 *
 * Applies one verified protocol outcome to an agent's reputation:
 * pure impact computation (shared-types) + idempotent persistence
 * in the caller's transaction. Hooks in risk/attestation/enforcement
 * pass their transaction client so the reputation effect commits
 * atomically with the outcome that caused it — never partially, and
 * never twice for the same source (UNIQUE + ON CONFLICT DO NOTHING).
 *
 * This service is ADVISORY ONLY: it writes scores and explanations.
 * It cannot touch attestors, bonds, wallets, chain state, or
 * enforcement — those modules are not imported here.
 */
import {
  REPUTATION_BASELINE_SCORE,
  REPUTATION_VERSION,
  applyReputationEvent,
  trustLevelForScore,
} from "@bond/shared-types";
import type {
  ReputationEventType,
  ReputationSourceType,
  RiskSeverity,
} from "@bond/shared-types";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import {
  findReputationEvent,
  getAgentReputationForUpdate,
  insertReputationEvent,
  reputationEventId,
  upsertAgentReputation,
} from "../db/stores/reputation.js";
import { recordEvent } from "./events.js";

export interface ReputationOutcome {
  readonly applied: boolean;
  readonly eventId: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly trustLevel: string;
  readonly impact: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly version: typeof REPUTATION_VERSION;
}

export interface ApplyReputationInput {
  readonly agentId: string;
  readonly eventType: ReputationEventType;
  readonly sourceType: ReputationSourceType;
  readonly sourceId: string;
  readonly severity?: RiskSeverity;
  readonly fullSlash?: boolean;
  readonly category?: string;
  readonly requestId?: string | null;
}

/**
 * Applies one reputation event. When `client` is supplied the effect
 * joins the caller's transaction; otherwise a dedicated transaction
 * is opened. Concurrent applications for the same agent serialize on
 * the state row; duplicates of the same source return the existing
 * outcome with `applied: false` and change nothing.
 */
export async function applyReputationEventService(
  input: ApplyReputationInput,
  client?: PoolClient,
): Promise<ReputationOutcome> {
  if (client) {
    return applyInTransaction(input, client);
  }
  return withTransaction(async (tx) => applyInTransaction(input, tx));
}

async function applyInTransaction(
  input: ApplyReputationInput,
  client: PoolClient,
): Promise<ReputationOutcome> {
  const eventId = reputationEventId(input.sourceType, input.sourceId);
  const existing = await findReputationEvent(
    input.agentId,
    input.sourceType,
    input.sourceId,
    client,
  );
  if (existing) {
    return {
      applied: false,
      eventId: existing.id,
      scoreBefore: existing.score_before,
      scoreAfter: existing.score_after,
      trustLevel: trustLevelForScore(existing.score_after),
      impact: existing.impact,
      reasonCode: existing.reason_code,
      reason: existing.reason,
      version: REPUTATION_VERSION,
    };
  }
  // Serialize concurrent distinct-source applications for this agent.
  // Agents without state start at the documented baseline (no write
  // until the first event lands).
  const state = await getAgentReputationForUpdate(input.agentId, client);
  const scoreBefore = state === null ? REPUTATION_BASELINE_SCORE : state.score;
  const computed = applyReputationEvent({
    scoreBefore,
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    severity: input.severity,
    fullSlash: input.fullSlash,
    category: input.category,
  });
  const nowIso = new Date().toISOString();
  const inserted = await insertReputationEvent(
    {
      id: eventId,
      agentId: input.agentId,
      eventType: computed.eventType,
      sourceType: computed.sourceType,
      sourceId: computed.sourceId,
      impact: computed.impact,
      scoreBefore: computed.scoreBefore,
      scoreAfter: computed.scoreAfter,
      reasonCode: computed.reasonCode,
      reason: computed.reason,
      reputationVersion: computed.version,
    },
    client,
  );
  if (!inserted) {
    // Lost a concurrent duplicate race after the pre-check: re-read
    // the winner so the caller sees the applied outcome.
    const winner = await findReputationEvent(
      input.agentId,
      input.sourceType,
      input.sourceId,
      client,
    );
    if (winner) {
      return {
        applied: false,
        eventId: winner.id,
        scoreBefore: winner.score_before,
        scoreAfter: winner.score_after,
        trustLevel: trustLevelForScore(winner.score_after),
        impact: winner.impact,
        reasonCode: winner.reason_code,
        reason: winner.reason,
        version: REPUTATION_VERSION,
      };
    }
  }
  const trustLevel = trustLevelForScore(computed.scoreAfter);
  await upsertAgentReputation(
    {
      agentId: input.agentId,
      score: computed.scoreAfter,
      trustLevel,
      version: REPUTATION_VERSION,
      updatedAt: nowIso,
    },
    client,
  );
  await recordEvent(
    {
      type: "REPUTATION_UPDATED",
      agentId: input.agentId,
      actor: "system:reputation",
      requestId: input.requestId,
      payload: {
        reputationEventId: eventId,
        eventType: computed.eventType,
        impact: computed.impact,
        scoreBefore: computed.scoreBefore,
        scoreAfter: computed.scoreAfter,
      },
    },
    client,
  );
  return {
    applied: inserted,
    eventId,
    scoreBefore: computed.scoreBefore,
    scoreAfter: computed.scoreAfter,
    trustLevel,
    impact: computed.impact,
    reasonCode: computed.reasonCode,
    reason: computed.reason,
    version: REPUTATION_VERSION,
  };
}
