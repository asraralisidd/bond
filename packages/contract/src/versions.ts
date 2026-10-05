/**
 * Contract + policy version identifiers.
 *
 * Convention: any change to enforced transition rules bumps
 * CONTRACT_VERSION; parameter-only changes bump CONTRACT_POLICY_VERSION.
 * Both travel in ledger state and adapter metadata so behavior is never
 * silent.
 */
export const CONTRACT_VERSION = "bond-contract-v1" as const;
export const CONTRACT_POLICY_VERSION = "bond-policy-v1" as const;
