/**
 * @bond/attestor — FOUNDATION SHELL ONLY.
 *
 * Attestation logic is NOT implemented. This module intentionally exposes
 * no signing/verification logic. It exists so imports/builds resolve.
 */

export const ATTESTOR_STATUS = "not-implemented" as const;

/** Placeholder stub. Always throws — real attestation is a later milestone. */
export function attest(): never {
  throw new Error(
    "@bond/attestor: attest() is not implemented (foundation shell only).",
  );
}
