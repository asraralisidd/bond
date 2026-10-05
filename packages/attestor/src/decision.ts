/**
 * Decision orchestration: independent evaluations → quorum → outcome.
 *
 * Deterministic pipeline (no clock, no randomness, no network):
 * 1. Eligible attestors only (eligibility policy; ineligible recorded).
 * 2. Each evaluates the flag independently (own evidence view/strictness).
 * 3. Late evaluations (at/after request expiry) are excluded.
 * 4. First verdict per attestor wins; repeats reported, never counted.
 * 5. Request expired at `nowIso` → outcome "expired" regardless of votes.
 * 6. Generalized quorum over counted verdicts → quorum-met / rejected / open.
 * 7. quorum-met → recommended action from flag severity
 *    (critical → full-slash, else partial-slash) + deterministic
 *    nullifier slot `bond-nullifier:<attestationId>:<riskFlagId>`.
 *    rejected/open/expired → no action.
 *
 * Output is a decision + a Phase 1 Attestation record built ONLY with
 * shared domain functions. Enforcement (slash/withdraw/tx) is NOT here —
 * the future chain layer consumes the decision.
 */
import {
  createAttestationRequest,
  issueDecision,
  parseAttestationId,
  parseDecisionId,
  recordVerdict,
} from "@bond/shared-types";
import type {
  Attestation,
  EnforcementAction,
  RiskFlag,
} from "@bond/shared-types";
import type { AttestorProfile } from "./attestor.js";
import { defaultEligibilityPolicy } from "./attestor.js";
import type { EligibilityPolicy } from "./attestor.js";
import { verifyEvidenceCoverage } from "./binding.js";
import { evaluateIndependently } from "./evaluator.js";
import type { IndependentEvaluation } from "./evaluator.js";
import { isFresh } from "./freshness.js";
import { DEFAULT_QUORUM_CONFIG } from "./policy.js";
import type { QuorumConfig } from "./policy.js";
import { evaluateQuorum } from "./quorum.js";
import type { QuorumOutcome } from "./quorum.js";
import { ATTESTOR_SYSTEM_VERSION } from "./versions.js";

export type DecisionStatus = QuorumOutcome | "expired";

export interface DecideInput {
  readonly attestationId: string;
  readonly flag: RiskFlag;
  /** All evidence the attestors may consult (IDs only). */
  readonly availableEvidenceIds: ReadonlySet<string>;
  readonly profiles: readonly AttestorProfile[];
  readonly eligibility?: EligibilityPolicy;
  readonly quorum?: QuorumConfig;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly policyVersion: string;
  readonly nowIso: string;
  /** Decision IDs are caller-supplied (infra); derived default if absent. */
  readonly decisionId?: string;
  readonly decisionExpiresAt?: string;
}

export interface DecisionOutcome {
  readonly status: DecisionStatus;
  readonly recommendedAction: EnforcementAction | null;
  /** Deterministic nullifier slot, set only when quorum is met. */
  readonly nullifier: string | null;
  readonly attestation: Attestation;
  readonly evaluations: readonly IndependentEvaluation[];
  readonly ineligibleAttestors: readonly string[];
  readonly systemVersion: typeof ATTESTOR_SYSTEM_VERSION;
}

function recommendedActionFor(flag: RiskFlag): EnforcementAction {
  return flag.severity === "critical" ? "full-slash" : "partial-slash";
}

export function decide(input: DecideInput): DecisionOutcome {
  const attestationId = parseAttestationId(input.attestationId);
  const eligibility = input.eligibility ?? defaultEligibilityPolicy;
  const quorum = input.quorum ?? DEFAULT_QUORUM_CONFIG;

  let attestation = createAttestationRequest({
    attestationId,
    riskFlagId: input.flag.riskFlagId,
    agentId: input.flag.agentId,
    evidenceRefs: input.flag.evidenceRefs.map((ref) => ref.evidenceId),
    policyVersion: input.policyVersion,
    threshold: quorum.required,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  });

  // The decision may only rest on the evidence the flag cited.
  verifyEvidenceCoverage(
    input.flag.evidenceRefs.map((ref) => ref.evidenceId as string),
    attestation.evidenceRefs.map((id) => id as string),
  );

  const evaluations: IndependentEvaluation[] = [];
  const ineligibleAttestors: string[] = [];
  for (const profile of input.profiles) {
    if (!eligibility.isEligible(profile.attestor)) {
      ineligibleAttestors.push(profile.attestor.attestorId as string);
      continue;
    }
    evaluations.push(
      evaluateIndependently(
        profile,
        input.flag,
        input.availableEvidenceIds,
        input.nowIso,
      ),
    );
  }

  // Count each attestor once (first verdict wins); exclude late verdicts.
  // Recording stops once the domain object closes (rejected): remaining
  // evaluations stay in `evaluations` for audit but cannot extend a
  // closed attestation (Phase 1 lifecycle preserved, not redefined).
  const seen = new Set<string>();
  for (const evaluation of evaluations) {
    if (attestation.status === "rejected" || attestation.status === "decided") {
      break;
    }
    const attestorKey = evaluation.attestorId as string;
    if (seen.has(attestorKey)) {
      continue;
    }
    seen.add(attestorKey);
    if (!isFresh(attestation.expiresAt, evaluation.evaluatedAt)) {
      continue;
    }
    attestation = recordVerdict(attestation, {
      attestorId: evaluation.attestorId,
      verdict: evaluation.verdict,
      bindingRef: `binding:${input.attestationId}:${attestorKey}`,
      issuedAt: evaluation.evaluatedAt,
    });
  }

  const counted = evaluateQuorum(
    attestation.verdicts.map((verdict) => ({
      attestorId: verdict.attestorId as string,
      verdict: verdict.verdict,
      issuedAt: verdict.issuedAt,
      requestExpiresAt: attestation.expiresAt,
    })),
    quorum,
  );

  if (!isFresh(attestation.expiresAt, input.nowIso)) {
    return {
      status: "expired",
      recommendedAction: null,
      nullifier: null,
      attestation,
      evaluations,
      ineligibleAttestors,
      systemVersion: ATTESTOR_SYSTEM_VERSION,
    };
  }

  if (counted.outcome === "quorum-met") {
    const nullifier = `bond-nullifier:${input.attestationId}:${input.flag.riskFlagId as string}`;
    const action = recommendedActionFor(input.flag);
    const withDecision = issueDecision(attestation, {
      decisionId: parseDecisionId(
        input.decisionId ?? `dec-${input.attestationId}`,
      ),
      action,
      nullifier,
      decisionExpiresAt: input.decisionExpiresAt ?? attestation.expiresAt,
      nowIso: input.nowIso,
    });
    return {
      status: "quorum-met",
      recommendedAction: action,
      nullifier,
      attestation: withDecision,
      evaluations,
      ineligibleAttestors,
      systemVersion: ATTESTOR_SYSTEM_VERSION,
    };
  }

  return {
    status: counted.outcome,
    recommendedAction: null,
    nullifier: null,
    attestation,
    evaluations,
    ineligibleAttestors,
    systemVersion: ATTESTOR_SYSTEM_VERSION,
  };
}
