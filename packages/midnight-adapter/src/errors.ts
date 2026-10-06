/**
 * Adapter error taxonomy: structured, transport-neutral, no secret leakage.
 *
 * Midnight.js failures (TxFailedError family) are mapped to these codes
 * at the seam so the rest of BOND never imports Midnight error types.
 * Error messages carry IDs and operation names only — never keys,
 * witnesses, amounts, or endpoints with credentials.
 */

export type MidnightErrorCode =
  | "MIDNIGHT_UNAVAILABLE"
  | "MIDNIGHT_CONFIG_INVALID"
  | "MIDNIGHT_SUBMISSION_FAILED"
  | "MIDNIGHT_CONFIRMATION_FAILED"
  | "MIDNIGHT_DEPLOY_FAILED"
  | "MIDNIGHT_READ_FAILED";

export class MidnightError extends Error {
  public readonly code: MidnightErrorCode;
  public readonly mode: "SIMULATED" | "REAL" | "UNAVAILABLE";
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: MidnightErrorCode,
    message: string,
    mode: MidnightError["mode"],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "MidnightError";
    this.code = code;
    this.mode = mode;
    this.details = details;
  }
}

export function isMidnightError(error: unknown): error is MidnightError {
  return error instanceof MidnightError;
}

/** Maps unknown throwables at the seam to MidnightError (fail-closed). */
export function toMidnightError(
  operation: string,
  mode: MidnightError["mode"],
  error: unknown,
): MidnightError {
  if (isMidnightError(error)) {
    return error;
  }
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return new MidnightError(
    "MIDNIGHT_SUBMISSION_FAILED",
    `Midnight ${operation} failed (${name})`,
    mode,
    { operation },
  );
}
