/**
 * Explicit failure classification for worker retries.
 *
 * - RETRYABLE: transient infrastructure failures (network, timeouts,
 *   adapter submission errors that did not report uncertainty).
 * - PERMANENT: domain/auth validation failures — retrying cannot help.
 *   Includes unknown-purpose and missing-record failures.
 * - ALREADY_COMPLETED: the effect already exists (unique violations,
 *   already-consumed nullifiers, already-confirmed reads).
 * - REQUIRES_RECONCILIATION: REAL submission threw after the call may
 *   have reached the chain. Never blindly resubmitted.
 *
 * Unknown errors default to RETRYABLE (bounded by maxAttempts) rather
 * than silently dropping work. Fail-closed, never fail-silent.
 */
import { DomainError } from "@bond/shared-types";
import { MidnightError } from "@bond/midnight-adapter";
import { ApiError } from "../../http/errors.js";
import type { FailureClass } from "./types.js";

const TRANSIENT_PATTERNS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "socket hang up",
  "timeout",
  "timed out",
  "temporarily unavailable",
  "too many requests",
  "429",
  "502",
  "503",
  "504",
];

const COMPLETED_PATTERNS = [
  "already exists",
  "already consumed",
  "already processed",
  "duplicate key",
  "23505",
];

const UNCERTAIN_PATTERNS = [
  "uncertain",
  "unknown submission outcome",
  "did not respond",
  "no response",
  // Worker-emitted marker for REAL intents with no wallet-attended
  // submission path: must resolve via reconciliation, never resubmit.
  "requires operator attention",
];

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (
    error instanceof DomainError ||
    (error instanceof ApiError && error.status >= 400 && error.status < 500)
  ) {
    return "PERMANENT";
  }
  if (error instanceof MidnightError) {
    // Adapter submission errors are retryable unless they signal that
    // the call may already have reached the chain.
    if (
      UNCERTAIN_PATTERNS.some((pattern) =>
        lowered.includes(pattern.toLowerCase()),
      )
    ) {
      return "REQUIRES_RECONCILIATION";
    }
    return "RETRYABLE";
  }
  if (
    COMPLETED_PATTERNS.some((pattern) =>
      lowered.includes(pattern.toLowerCase()),
    )
  ) {
    return "ALREADY_COMPLETED";
  }
  if (
    UNCERTAIN_PATTERNS.some((pattern) =>
      lowered.includes(pattern.toLowerCase()),
    )
  ) {
    return "REQUIRES_RECONCILIATION";
  }
  if (
    TRANSIENT_PATTERNS.some((pattern) =>
      lowered.includes(pattern.toLowerCase()),
    )
  ) {
    return "RETRYABLE";
  }
  return "RETRYABLE";
}

/** Operator-safe one-line message: class + sliced detail, no internals. */
export function safeFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 200);
}
