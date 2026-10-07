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
  INVALID_POLICY: 400,
  INVALID_DELEGATION: 400,
  DELEGATION_DENIED: 403,
  POLICY_VERSION_CONFLICT: 409,
  INVALID_ACTIVITY_INPUT: 400,
  INVALID_ELIGIBILITY_PROOF: 400,
  INVALID_TIMESTAMP: 400,
  EXPIRED_ATTESTATION: 410,
  EXPIRED_ELIGIBILITY_PROOF: 410,
  REPLAYED_ATTESTATION: 409,
  REPLAYED_ELIGIBILITY_PROOF: 409,
  REPLAYED_ACTIVITY: 409,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  REQUEST_TIMEOUT: 503,
  BODY_TOO_LARGE: 413,
  MIDNIGHT_UNAVAILABLE: 502,
  MIDNIGHT_CONFIG_INVALID: 500,
  MIDNIGHT_SUBMISSION_FAILED: 502,
  MIDNIGHT_CONFIRMATION_FAILED: 502,
  MIDNIGHT_DEPLOY_FAILED: 502,
  MIDNIGHT_READ_FAILED: 502,
};

/**
 * Fixed client-safe messages for adapter failures. The underlying
 * library message (constructor names, provider internals) never reaches
 * clients — it goes to structured logs only.
 */
const MIDNIGHT_SAFE_MESSAGES: Record<string, string> = {
  MIDNIGHT_UNAVAILABLE: "Blockchain integration unavailable",
  MIDNIGHT_CONFIG_INVALID: "Blockchain integration misconfigured",
  MIDNIGHT_SUBMISSION_FAILED: "Transaction submission failed",
  MIDNIGHT_CONFIRMATION_FAILED: "Transaction confirmation failed",
  MIDNIGHT_DEPLOY_FAILED: "Contract deployment failed",
  MIDNIGHT_READ_FAILED: "Blockchain read failed",
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
    const message =
      error instanceof MidnightError
        ? (MIDNIGHT_SAFE_MESSAGES[code] ?? "Blockchain operation failed")
        : error.message;
    logError(
      {
        metadata: {
          ...emptyLogMetadata(),
          requestId,
        },
        operation: "error-handler",
        errorCode: code,
      },
      error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
    );
    res.status(HTTP_STATUS[code] ?? 500).json({
      code,
      message,
      requestId,
    } satisfies ApiErrorBody);
    return;
  }
  logError(
    { metadata: emptyLogMetadata(), operation: "error-handler" },
    "Internal error",
  );
  if (
    error instanceof Error &&
    (error as Error & { type?: string }).type === "entity.too.large"
  ) {
    res.status(413).json({
      code: "BODY_TOO_LARGE",
      message: "Request body exceeds the configured limit",
      requestId,
    } satisfies ApiErrorBody);
    return;
  }
  res.status(500).json({
    code: "INTERNAL_ERROR",
    message: "Internal error",
    requestId,
  } satisfies ApiErrorBody);
}
