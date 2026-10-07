/**
 * Framework-free error model. Mirrors the backend safe envelope
 * ({code, message, requestId}) plus the Retry-After signal on 429s.
 * Never carries credentials, tokens, or request bodies.
 */
export class BondApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId: string | null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "BondApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

/**
 * Parse a Retry-After header value (delta-seconds). Returns null when
 * absent or unparsable — callers decide whether to retry; the SDK never
 * retries automatically (no retry storms).
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * User-facing message for API failures. Rate limiting gets a calm,
 * actionable message; everything else surfaces code + message.
 */
export function friendlyMessage(error: unknown): string {
  if (error instanceof BondApiError && error.code === "RATE_LIMITED") {
    return "Too many requests — please wait a moment and try again.";
  }
  if (error instanceof BondApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
