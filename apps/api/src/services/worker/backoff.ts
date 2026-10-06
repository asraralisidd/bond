/**
 * Deterministic exponential backoff with stable jitter.
 *
 * delay = min(maxMs, baseMs * 2^(attempt-1)) + jitter, where jitter is
 * derived from a stable hash of the job id (0..999ms). No Math.random():
 * identical inputs reproduce identical schedules across restarts, while
 * distinct jobs still spread their retries instead of thundering.
 */
import { createHash } from "node:crypto";

export function computeBackoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jobId: string,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = baseMs * 2 ** (safeAttempt - 1);
  const capped = Math.min(maxMs, exponential);
  const digest = createHash("sha256").update(jobId, "utf8").digest();
  const jitter = digest.readUInt16BE(0) % 1000;
  return capped + jitter;
}

/** ISO timestamp `delayMs` after `fromIso` (injectable clock in tests). */
export function addMsIso(fromIso: string, delayMs: number): string {
  return new Date(Date.parse(fromIso) + delayMs).toISOString();
}
