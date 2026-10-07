/**
 * Version tags for every behavior-defining layer.
 *
 * Convention: any change to scoring behavior, rule semantics, or engine
 * orchestration REQUIRES a bump of the corresponding version. Versions
 * travel on every RiskFlag (`modelVersion`) and every analysis result so
 * decisions are reproducible. Additive-only within a tag family; a
 * behavior break starts a new tag (e.g. `ruleset-v2`).
 */
export const ENGINE_VERSION = "engine-v1" as const;
export const RULE_SET_VERSION = "ruleset-v1" as const;
export const SCORING_MODEL_VERSION = "scoring-v1" as const;

/**
 * Phase 20 behavioral additions. Additive only: v1 tags keep their
 * exact meaning; behavioral findings carry v2 stamps. A v1-only
 * analysis never observes these identifiers.
 */
export const RULE_SET_V2 = "ruleset-v2" as const;
export const SCORING_V2 = "scoring-v2" as const;

/** Combined scorer identity stamped on emitted RiskFlags. */
export function scorerVersionString(): string {
  return `bond-risk-engine/${ENGINE_VERSION} ruleset/${RULE_SET_VERSION} scoring/${SCORING_MODEL_VERSION}`;
}

/** Scorer identity for analyses containing behavioral findings. */
export function behavioralScorerVersionString(): string {
  return `bond-risk-engine/${ENGINE_VERSION} ruleset/${RULE_SET_V2} scoring/${SCORING_V2}`;
}
