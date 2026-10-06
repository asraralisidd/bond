/**
 * API error model: stable machine-readable codes, safe messages.
 *
 * DomainError/MidnightError codes pass through; everything else becomes
 * INTERNAL_ERROR. Stack traces, SQL text, and secrets never leave the
 * process — messages carry IDs and operation names only.
 */
import type { Request, Response, NextFunction } from "express";
import { DomainError } from "@bond/shared-types";
import { MidnightError } from "@bond/midnight-adapter";
import { logError } from "../observability.js";
import { emptyLogMetadata } from "@bond/shared-types";

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

const HTTP_STATUS: Record<string, number> = {
  INVALID_IDENTIFIER: 400,
  INVALID_AGENT_TRANSITION: 400,
  INVALID_BOND_TRANSITION: 400,
  INVALID_TRANSACTION_TRANSITION: 400,
  INVALID_RISK_FLAG_TRANSITION: 400,
  INVALID_RISK_FLAG: 400,
  INVALID_ATTESTATION: 400,
  INVALID_SLASH_EVENT: 400,
  INVALID_SLASH_TRANSITION: 400,
  INVALID_REPUTATION_INPUT: 400,
  INVALID_ACTIVITY_INPUT: 400,
  INVALID_ELIGIBILITY_PROOF: 400,
  INVALID_TIMESTAMP: 400,
  EXPIRED_ATTESTATION: 410,
  EXPIRED_ELIGIBILITY_PROOF: 410,
  REPLAYED_ATTESTATION: 409,
  REPLAYED_ELIGIBILITY_PROOF: 409,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  MIDNIGHT_UNAVAILABLE: 502,
  MIDNIGHT_CONFIG_INVALID: 500,
  MIDNIGHT_SUBMISSION_FAILED: 502,
  MIDNIGHT_CONFIRMATION_FAILED: 502,
  MIDNIGHT_DEPLOY_FAILED: 502,
  MIDNIGHT_READ_FAILED: 502,
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
  }
}

export function notFound(resource: string): ApiError {
  return new ApiError("NOT_FOUND", `${resource} not found`);
}

export function forbidden(message = "Forbidden"): ApiError {
  return new ApiError("FORBIDDEN", message);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId =
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : null;
  if (error instanceof ApiError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      requestId,
    } satisfies ApiErrorBody);
    return;
  }
  if (error instanceof DomainError || error instanceof MidnightError) {
    const code = error.code;
    res.status(HTTP_STATUS[code] ?? 500).json({
      code,
      message: error.message,
      requestId,
    } satisfies ApiErrorBody);
    return;
  }
  logError(
    { metadata: emptyLogMetadata(), operation: "error-handler" },
    "Internal error",
  );
  res.status(500).json({
    code: "INTERNAL_ERROR",
    message: "Internal error",
    requestId,
  } satisfies ApiErrorBody);
}
