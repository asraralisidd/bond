/**
 * @bond/midnight-adapter — FOUNDATION SHELL ONLY.
 *
 * Midnight / Compact / ZK integration is NOT implemented and no official
 * APIs are invented here. This module exists only so future wiring has a
 * stable import path. Availability of Midnight tooling is UNVERIFIED in
 * this environment (see docs/architecture-notes.md).
 */

export const MIDNIGHT_ADAPTER_STATUS = "not-implemented" as const;

/** Placeholder stub. Always throws — real integration is a later milestone. */
export function connectMidnight(): never {
  throw new Error(
    "@bond/midnight-adapter: connectMidnight() is not implemented and no Midnight API is assumed.",
  );
}
