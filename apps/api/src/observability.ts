/**
 * Structured logging with the Phase 0/1 observability conventions.
 *
 * Only allowlisted correlation fields (DomainLogMetadata) plus safe
 * operation context may be logged. There is no code path that accepts
 * private values — secrets, amounts, witnesses, and evidence content
 * cannot reach logs because no parameter slot exists for them.
 */
import pino from "pino";
import type { DomainLogMetadata } from "@bond/shared-types";

export interface LogContext {
  readonly metadata: DomainLogMetadata;
  readonly operation?: string;
  readonly errorCode?: string;
}

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export interface LogRecord {
  readonly requestId: string | null;
  readonly agentId: string | null;
  readonly riskFlagId: string | null;
  readonly attestationId: string | null;
  readonly transactionId: string | null;
  readonly operation: string | null;
  readonly errorCode: string | null;
  readonly msg: string;
}

/** Pure record builder: the complete allowlist of loggable fields. */
export function buildLogRecord(
  context: LogContext,
  message: string,
): LogRecord {
  return {
    requestId: context.metadata.requestId,
    agentId: context.metadata.agentId,
    riskFlagId: context.metadata.riskFlagId,
    attestationId: context.metadata.attestationId,
    transactionId: context.metadata.transactionId,
    operation: context.operation ?? null,
    errorCode: context.errorCode ?? null,
    msg: message,
  };
}

export function logInfo(context: LogContext, message: string): void {
  logger.info(buildLogRecord(context, message));
}

export function logError(context: LogContext, message: string): void {
  logger.error(buildLogRecord(context, message));
}
