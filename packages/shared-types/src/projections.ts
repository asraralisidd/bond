/**
 * Public projections: the privacy boundary in code.
 *
 * SECURITY RULE (Phase 0 doc 08): private data crosses into public views
 * only through defined gateways. These projection functions build fresh
 * allowlisted objects — they NEVER spread the internal record — so a new
 * private field added later cannot leak by accident. Tests in
 * projections.test.ts prove private fields are absent from serialized
 * output; do not rely on developer discipline alone.
 *
 * PRIVATE (never in these outputs): exact bond/slash amounts, funding
 * sources, evidence content/hashes, witnesses, model internals, attestor
 * notes, operator PII, keys, blinding values, signing secrets.
 */
import type { Agent } from "./agent.js";
import type { Bond } from "./bond.js";
import type { ReputationRecord } from "./reputation.js";
import type { RiskFlag } from "./risk-flag.js";
import type { SlashEvent } from "./slash-event.js";
import type {
  AgentStatus,
  BondStatus,
  ReputationStanding,
  RiskSeverity,
  VerificationResult,
} from "./enums.js";

export interface PublicAgentView {
  readonly agentId: string;
  readonly platform: string;
  readonly agentType: string;
  readonly registrationStatus: AgentStatus;
  /** Derived active/inactive marker. True for ELIGIBLE/ACTIVE/FLAGGED. */
  readonly isActive: boolean;
  readonly reputationStanding: ReputationStanding;
  readonly bondStatus: BondStatus;
  readonly openFlagCount: number;
}

export interface PublicBondView {
  /** Status band only — never amounts (Phase 0 doc 12 §12.2). */
  readonly status: BondStatus;
  readonly policyVersion: string;
}

export interface PublicReputationView {
  readonly standing: ReputationStanding;
  readonly confirmedFlags: number;
  readonly partialSlashes: number;
  readonly fullSlashes: number;
  readonly resolvedWithRemediation: number;
}

export interface PublicSlashRecord {
  readonly slashEventId: string;
  /** "partial" | "full" band — never exact amounts. */
  readonly band: "partial" | "full";
  readonly severity: RiskSeverity;
  readonly completedAt: string | null;
}

export interface PublicVerificationView {
  readonly agentId: string;
  readonly result: VerificationResult;
  /** Freshness label (Phase 0 doc 12 §12.3). */
  readonly asOf: string;
  readonly policyVersion: string;
  readonly rulesVersion: "v0";
  readonly registrationStatus: AgentStatus;
  readonly bondStatus: BondStatus;
  readonly reputationStanding: ReputationStanding;
  readonly slashCount: number;
}

const ACTIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "ELIGIBLE",
  "ACTIVE",
  "FLAGGED",
]);

export function toPublicAgentView(input: {
  readonly agent: Pick<Agent, "agentId" | "platform" | "agentType" | "status">;
  readonly reputationStanding: ReputationStanding;
  readonly bondStatus: BondStatus;
  readonly openFlagCount: number;
}): PublicAgentView {
  return {
    agentId: input.agent.agentId,
    platform: input.agent.platform,
    agentType: input.agent.agentType,
    registrationStatus: input.agent.status,
    isActive: ACTIVE_AGENT_STATUSES.has(input.agent.status),
    reputationStanding: input.reputationStanding,
    bondStatus: input.bondStatus,
    openFlagCount: input.openFlagCount,
  };
}

export function toPublicBondView(
  bond: Pick<Bond, "status" | "policyVersion">,
): PublicBondView {
  return {
    status: bond.status,
    policyVersion: bond.policyVersion,
  };
}

export function toPublicReputationView(
  record: Pick<ReputationRecord, "standing" | "factors">,
): PublicReputationView {
  return {
    standing: record.standing,
    confirmedFlags: record.factors.confirmedFlags,
    partialSlashes: record.factors.partialSlashes,
    fullSlashes: record.factors.fullSlashes,
    resolvedWithRemediation: record.factors.remediatedResolutions,
  };
}

export function toPublicSlashRecord(
  event: Pick<
    SlashEvent,
    "slashEventId" | "isFullSlash" | "severity" | "completedAt"
  >,
): PublicSlashRecord {
  return {
    slashEventId: event.slashEventId,
    band: event.isFullSlash ? "full" : "partial",
    severity: event.severity,
    completedAt: event.completedAt,
  };
}

/**
 * Computes a public verification verdict from public-safe inputs only.
 * Rules v0 (documented, deterministic):
 * - FULLY_SLASHED bond or poor standing → "untrusted".
 * - Any completed slash, open flag, or probation standing → "caution".
 * - Otherwise, bonded+eligible+active with good standing → "trusted".
 * - Anything else (e.g. unbonded) → "caution" (soundness over
 *   completeness: never claim trust without a bonded basis).
 */
export function verifyAgentPublic(input: {
  readonly agentId: string;
  readonly registrationStatus: AgentStatus;
  readonly bondStatus: BondStatus;
  readonly reputationStanding: ReputationStanding;
  readonly completedSlashCount: number;
  readonly openFlagCount: number;
  readonly asOf: string;
  readonly policyVersion: string;
}): PublicVerificationView {
  let result: VerificationResult = "caution";
  if (
    input.bondStatus === "FULLY_SLASHED" ||
    input.reputationStanding === "poor"
  ) {
    result = "untrusted";
  } else if (
    input.completedSlashCount === 0 &&
    input.openFlagCount === 0 &&
    input.reputationStanding === "good" &&
    (input.registrationStatus === "ACTIVE" ||
      input.registrationStatus === "ELIGIBLE" ||
      input.registrationStatus === "BONDED")
  ) {
    result = "trusted";
  } else if (
    input.completedSlashCount > 0 ||
    input.openFlagCount > 0 ||
    input.reputationStanding === "probation"
  ) {
    result = "caution";
  }
  return {
    agentId: input.agentId,
    result,
    asOf: input.asOf,
    policyVersion: input.policyVersion,
    rulesVersion: "v0",
    registrationStatus: input.registrationStatus,
    bondStatus: input.bondStatus,
    reputationStanding: input.reputationStanding,
    slashCount: input.completedSlashCount,
  };
}

/** Public-safe flag summary: counts only, no evidence content or hashes. */
export function countOpenFlags(
  flags: readonly Pick<RiskFlag, "status">[],
): number {
  return flags.filter((f) => f.status === "open" || f.status === "under-review")
    .length;
}
