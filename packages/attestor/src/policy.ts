/**
 * Quorum configuration + validation (generalized, not hardcoded 2-of-3).
 *
 * Rule: 0 < required <= total, integers. The default policy is
 * required=2/total=3; any other formation (1-of-1, 3-of-5, …) uses the
 * same mechanism. No governance lives here — configuration arrives from
 * policy and is validated, never invented.
 */
import { DomainError } from "@bond/shared-types";
import { QUORUM_POLICY_VERSION } from "./versions.js";

export interface QuorumConfig {
  readonly required: number;
  readonly total: number;
  readonly policyVersion: typeof QUORUM_POLICY_VERSION;
}

export const DEFAULT_QUORUM_CONFIG: QuorumConfig = {
  required: 2,
  total: 3,
  policyVersion: QUORUM_POLICY_VERSION,
};

export function createQuorumConfig(
  required: number,
  total: number,
): QuorumConfig {
  if (!Number.isInteger(required) || !Number.isInteger(total)) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Quorum required/total must be integers",
      { required, total },
    );
  }
  if (required <= 0 || required > total) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Quorum must satisfy 0 < required <= total",
      { required, total },
    );
  }
  return { required, total, policyVersion: QUORUM_POLICY_VERSION };
}
