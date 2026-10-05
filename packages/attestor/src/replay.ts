/**
 * Domain-level replay protection (semantics only, no cryptography).
 *
 * A consumed attestation/decision key must never count again. Keys are
 * opaque strings (attestation IDs, binding refs, nullifiers); consumption
 * storage is a later-phase concern (ultimately on-chain nullifiers).
 * These helpers are pure: check-then-add over caller-held sets.
 */
import { DomainError } from "@bond/shared-types";

/** Throws REPLAYED_ATTESTATION when the key was already consumed. */
export function assertNotReplayed(
  key: string,
  consumedKeys: ReadonlySet<string>,
  context: string,
): void {
  if (key.length === 0) {
    throw new DomainError("INVALID_ATTESTATION", "Replay key is required", {
      context,
    });
  }
  if (consumedKeys.has(key)) {
    throw new DomainError(
      "REPLAYED_ATTESTATION",
      `Replayed attestation artifact: ${context}`,
      { context, key },
    );
  }
}

/** Returns a new set with the key marked consumed (immutable update). */
export function markConsumed(
  key: string,
  consumedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  assertNotReplayed(key, consumedKeys, "mark-consumed");
  return new Set([...consumedKeys, key]);
}
