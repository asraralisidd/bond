/**
 * Generalized quorum evaluation over counted verdicts.
 *
 * Deterministic conflict rules (documented):
 * - One attestor, one vote: duplicates collapse to the FIRST verdict; the
 *   repeat is reported in `duplicatesSkipped`, never double-counted.
 * - ABSTAIN counts toward neither side but is recorded.
 * - confirms ≥ required → "quorum-met" (checked first: approval wins ties
 *   only in evaluation order, see below).
 * - rejects ≥ required → "rejected".
 * - Otherwise → "open" (awaiting further verdicts).
 * - Tie at threshold on both sides simultaneously (possible only when
 *   required ≤ total/2, e.g. 1-of-2): confirms take precedence and the
 *   tie is reported in `reasons`. Rationale: an enforcement-worthy claim
 *   with threshold support proceeds to the decision stage, where expiry,
 *   binding, and replay checks still apply — quorum-met authorizes a
 *   decision, not an execution.
 */
import type { AttestationVerdict } from "@bond/shared-types";
import type { QuorumConfig } from "./policy.js";
import { createQuorumConfig } from "./policy.js";

export interface CountedVerdict {
  readonly attestorId: string;
  readonly verdict: AttestationVerdict;
  /** Verdicts at/after request expiry are excluded (late). */
  readonly issuedAt: string;
  readonly requestExpiresAt: string;
}

export type QuorumOutcome = "quorum-met" | "rejected" | "open";

export interface QuorumResult {
  readonly outcome: QuorumOutcome;
  readonly confirms: number;
  readonly rejects: number;
  readonly abstains: number;
  readonly countedAttestors: readonly string[];
  readonly duplicatesSkipped: readonly string[];
  readonly lateSkipped: readonly string[];
  readonly reasons: readonly string[];
}

function isLate(verdict: CountedVerdict): boolean {
  return Date.parse(verdict.issuedAt) >= Date.parse(verdict.requestExpiresAt);
}

export function evaluateQuorum(
  verdicts: readonly CountedVerdict[],
  config: QuorumConfig,
): QuorumResult {
  const validated = createQuorumConfig(config.required, config.total);
  const seen = new Set<string>();
  const duplicatesSkipped: string[] = [];
  const lateSkipped: string[] = [];
  let confirms = 0;
  let rejects = 0;
  let abstains = 0;
  const countedAttestors: string[] = [];
  for (const verdict of verdicts) {
    if (seen.has(verdict.attestorId)) {
      duplicatesSkipped.push(verdict.attestorId);
      continue;
    }
    seen.add(verdict.attestorId);
    if (isLate(verdict)) {
      lateSkipped.push(verdict.attestorId);
      continue;
    }
    countedAttestors.push(verdict.attestorId);
    if (verdict.verdict === "confirm") {
      confirms += 1;
    } else if (verdict.verdict === "reject") {
      rejects += 1;
    } else {
      abstains += 1;
    }
  }
  const reasons: string[] = [];
  if (
    confirms >= validated.required &&
    rejects >= validated.required &&
    validated.required > 0
  ) {
    reasons.push("threshold-tie: confirms take precedence over rejects");
  }
  if (confirms >= validated.required) {
    return {
      outcome: "quorum-met",
      confirms,
      rejects,
      abstains,
      countedAttestors,
      duplicatesSkipped,
      lateSkipped,
      reasons,
    };
  }
  if (rejects >= validated.required) {
    return {
      outcome: "rejected",
      confirms,
      rejects,
      abstains,
      countedAttestors,
      duplicatesSkipped,
      lateSkipped,
      reasons,
    };
  }
  return {
    outcome: "open",
    confirms,
    rejects,
    abstains,
    countedAttestors,
    duplicatesSkipped,
    lateSkipped,
    reasons,
  };
}
