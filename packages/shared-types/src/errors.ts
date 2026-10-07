/**
 * Machine-readable domain errors.
 *
 * These carry a stable `code` plus structured `details` for future API
 * layers. They are transport-neutral: no HTTP status, no framework
 * dependency.
 */
export type DomainErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_AGENT_TRANSITION"
  | "INVALID_BOND_TRANSITION"
  | "INVALID_TRANSACTION_TRANSITION"
  | "INVALID_RISK_FLAG_TRANSITION"
  | "INVALID_RISK_FLAG"
  | "INVALID_ATTESTATION"
  | "EXPIRED_ATTESTATION"
  | "REPLAYED_ATTESTATION"
  | "INVALID_SLASH_EVENT"
  | "INVALID_SLASH_TRANSITION"
  | "INVALID_REPUTATION_INPUT"
  | "INVALID_POLICY"
  | "INVALID_ACTIVITY_INPUT"
  | "INVALID_ELIGIBILITY_PROOF"
  | "EXPIRED_ELIGIBILITY_PROOF"
  | "REPLAYED_ELIGIBILITY_PROOF"
  | "INVALID_TIMESTAMP";

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
