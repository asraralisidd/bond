/**
 * Version tags for the attestor layer.
 *
 * Convention (same as Phase 2): any behavior change bumps the owning
 * version. Evaluation policy is versioned separately from the
 * orchestration engine so threshold tuning never silently changes history.
 */
export const ATTESTOR_SYSTEM_VERSION = "attestor-v1" as const;
export const EVALUATION_POLICY_VERSION = "eval-policy-v1" as const;
export const QUORUM_POLICY_VERSION = "quorum-policy-v1" as const;
