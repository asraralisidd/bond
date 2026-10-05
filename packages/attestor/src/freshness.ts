/**
 * Freshness validation with injected time (no clock reads in core logic).
 *
 * Boundary rule: fresh iff nowIso < expiresAt, strictly. Exactly at the
 * boundary counts as EXPIRED — enforcement must never race expiry.
 */
import { DomainError, isIsoTimestamp } from "@bond/shared-types";

function assertTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new DomainError("INVALID_TIMESTAMP", `Invalid timestamp: ${field}`, {
      field,
    });
  }
}

/** True when `nowIso` is strictly before `expiresAt`. */
export function isFresh(expiresAt: string, nowIso: string): boolean {
  assertTimestamp(expiresAt, "expiresAt");
  assertTimestamp(nowIso, "now");
  return Date.parse(nowIso) < Date.parse(expiresAt);
}

/**
 * Verdict-level freshness: a verdict issued at/after request expiry is
 * late and must not count toward quorum. Throws EXPIRED_ATTESTATION.
 */
export function assertVerdictFresh(issuedAt: string, expiresAt: string): void {
  assertTimestamp(issuedAt, "issuedAt");
  assertTimestamp(expiresAt, "expiresAt");
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) {
    throw new DomainError(
      "EXPIRED_ATTESTATION",
      "Verdict issued at or after expiry",
      { issuedAt, expiresAt },
    );
  }
}
