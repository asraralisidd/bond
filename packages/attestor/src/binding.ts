/**
 * Subject + evidence binding verification.
 *
 * An attestation is bound to exactly one (agent, flag) pair and to the
 * evidence it evaluated. Cross-subject reuse — Agent A's attestation for
 * Agent B, or one flag's verdicts for another flag — is rejected here,
 * before quorum counting. No cryptography: ID equality over caller-held
 * records (on-chain binding verification arrives in later phases).
 */
import { DomainError } from "@bond/shared-types";

export interface BindingSubject {
  readonly agentId: string;
  readonly riskFlagId: string;
}

/**
 * Verifies the attestation record names the expected subject.
 * Throws INVALID_ATTESTATION identifying the mismatched dimension.
 */
export function verifySubjectBinding(
  attestationSubject: BindingSubject,
  expectedSubject: BindingSubject,
): void {
  if (attestationSubject.agentId !== expectedSubject.agentId) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation agent mismatch: cannot apply across agents",
      {
        attestationAgent: attestationSubject.agentId,
        expectedAgent: expectedSubject.agentId,
      },
    );
  }
  if (attestationSubject.riskFlagId !== expectedSubject.riskFlagId) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation flag mismatch: cannot reuse across findings",
      {
        attestationFlag: attestationSubject.riskFlagId,
        expectedFlag: expectedSubject.riskFlagId,
      },
    );
  }
}

/**
 * Verifies the attestation references every evidence item the flag cited.
 * An attestation evaluated against different evidence cannot stand in for
 * this finding. Extra references are permitted (supplementary context);
 * missing ones are not.
 */
export function verifyEvidenceCoverage(
  flagEvidenceIds: readonly string[],
  attestationEvidenceIds: readonly string[],
): void {
  const covered = new Set(attestationEvidenceIds);
  const missing = flagEvidenceIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "Attestation evidence does not cover the evaluated finding",
      { missing },
    );
  }
}
