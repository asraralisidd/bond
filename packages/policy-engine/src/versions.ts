/**
 * Version tag for the policy evaluation policy.
 *
 * Convention (mirrors risk-engine): any change to evaluation
 * behavior REQUIRES a bump. Additive-only within the tag; a
 * behavior break starts a new tag (e.g. `policy-v2`).
 */
export const POLICY_VERSION = "policy-v1" as const;
