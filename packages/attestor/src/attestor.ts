/**
 * Attestor identity: an abstract domain concept.
 *
 * An attestor is identified, described, and status-tracked — nothing more.
 * There are NO wallet keys, private keys, blockchain accounts, or
 * cryptographic signatures in this phase. Verification material arrives
 * in later phases through the opaque `bindingRef` slot (Phase 1).
 */
import { DomainError } from "@bond/shared-types";
import { parseAttestorId } from "@bond/shared-types";
import type { AttestorId } from "@bond/shared-types";

export type AttestorStatus = "active" | "suspended" | "retired";

const ATTESTOR_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "suspended",
  "retired",
]);

export interface Attestor {
  readonly attestorId: AttestorId;
  readonly displayName: string | null;
  /** Declared independence: distinct organizations back quorum trust. */
  readonly organization: string;
  readonly jurisdiction: string | null;
  readonly status: AttestorStatus;
  readonly registeredAt: string;
}

export interface CreateAttestorInput {
  readonly attestorId: string;
  readonly displayName?: string | null;
  readonly organization: string;
  readonly jurisdiction?: string | null;
  readonly status?: AttestorStatus;
  readonly registeredAt: string;
}

/** Strictness shifts evaluation thresholds deterministically (see evaluator.ts). */
export type AttestorStrictness = -1 | 0 | 1;

export interface AttestorProfile {
  readonly attestor: Attestor;
  /** -1 lenient (thresholds −0.1), 0 standard, +1 strict (+0.1). */
  readonly strictness: AttestorStrictness;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_ATTESTATION", `Invalid attestor: ${field}`, {
      field,
    });
  }
  return value.trim();
}

export function createAttestor(input: CreateAttestorInput): Attestor {
  const status = input.status ?? "active";
  if (!ATTESTOR_STATUSES.has(status)) {
    throw new DomainError("INVALID_ATTESTATION", "Invalid attestor status", {
      status,
    });
  }
  return {
    attestorId: parseAttestorId(input.attestorId),
    displayName: input.displayName ?? null,
    organization: requireText(input.organization, "organization"),
    jurisdiction: input.jurisdiction ?? null,
    status,
    registeredAt: requireText(input.registeredAt, "registeredAt"),
  };
}

/**
 * Eligibility policy interface: future governance/admission plugs in here.
 * Default implementation below: only `active` attestors participate.
 */
export interface EligibilityPolicy {
  readonly policyVersion: string;
  isEligible(attestor: Attestor): boolean;
}

export const defaultEligibilityPolicy: EligibilityPolicy = {
  policyVersion: "eligibility-v1",
  isEligible(attestor) {
    return attestor.status === "active";
  },
};
