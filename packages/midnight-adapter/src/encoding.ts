/**
 * Domain ↔ Compact value encoding (deterministic, reversible where needed).
 *
 * - IDs: BOND domain strings → SHA-256 (Node crypto, standard library —
 *   key derivation for fixed-size Map keys, NOT ZK cryptography).
 * - Statuses: Phase 1 terms ↔ Uint<8> circuit codes, both directions.
 * - Amounts: digit strings ↔ bigint (Uint<64> range-checked).
 */
import { createHash } from "node:crypto";
import { DomainError } from "@bond/shared-types";
import type { ContractAgentStatus, ContractBondStatus } from "@bond/contract";

export const AGENT_STATUS_CODES: Readonly<Record<ContractAgentStatus, number>> =
  {
    REGISTERED: 1,
    BONDED: 2,
    ACTIVE: 3,
    FLAGGED: 4,
    SLASHED: 5,
    RESOLVED: 6,
  };

export const BOND_STATUS_CODES: Readonly<Record<ContractBondStatus, number>> = {
  ACTIVE: 1,
  LOCKED: 2,
  PARTIALLY_SLASHED: 3,
  FULLY_SLASHED: 4,
  WITHDRAWABLE: 5,
  WITHDRAWN: 6,
  CANCELLED: 7,
};

const AGENT_STATUS_BY_CODE: Readonly<Record<number, ContractAgentStatus>> =
  Object.fromEntries(
    Object.entries(AGENT_STATUS_CODES).map(([status, code]) => [code, status]),
  ) as Readonly<Record<number, ContractAgentStatus>>;

const BOND_STATUS_BY_CODE: Readonly<Record<number, ContractBondStatus>> =
  Object.fromEntries(
    Object.entries(BOND_STATUS_CODES).map(([status, code]) => [code, status]),
  ) as Readonly<Record<number, ContractBondStatus>>;

/** Domain ID → fixed-size on-chain key. Deterministic. */
export function domainIdToBytes32(domainId: string): Uint8Array {
  if (domainId.length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", "domainId required", {});
  }
  return new Uint8Array(createHash("sha256").update(domainId, "utf8").digest());
}

/** Nullifier strings (already opaque) → fixed-size key. */
export function nullifierToBytes32(nullifier: string): Uint8Array {
  return domainIdToBytes32(`bond-nullifier:${nullifier}`);
}

/**
 * Eligibility nullifiers use a SEPARATE domain prefix from enforcement
 * nullifiers: a proof nullifier can never validate as an enforcement
 * nullifier and vice versa, even if the raw strings collided.
 */
export function eligibilityNullifierToBytes32(nullifier: string): Uint8Array {
  return domainIdToBytes32(`bond-eligibility-nullifier:${nullifier}`);
}

/** Policy versions hash to fixed-size on-chain identifiers (D1 pattern). */
export function policyVersionToBytes32(policyVersion: string): Uint8Array {
  return domainIdToBytes32(`bond-policy:${policyVersion}`);
}

export function agentStatusToCode(status: ContractAgentStatus): bigint {
  return BigInt(AGENT_STATUS_CODES[status]);
}

export function agentStatusFromCode(code: bigint): ContractAgentStatus {
  const status = AGENT_STATUS_BY_CODE[Number(code)];
  if (status === undefined) {
    throw new DomainError(
      "INVALID_AGENT_TRANSITION",
      "Unknown agent status code",
      {
        code: code.toString(),
      },
    );
  }
  return status;
}

export function bondStatusToCode(status: ContractBondStatus): bigint {
  return BigInt(BOND_STATUS_CODES[status]);
}

export function bondStatusFromCode(code: bigint): ContractBondStatus {
  const status = BOND_STATUS_BY_CODE[Number(code)];
  if (status === undefined) {
    throw new DomainError(
      "INVALID_BOND_TRANSITION",
      "Unknown bond status code",
      {
        code: code.toString(),
      },
    );
  }
  return status;
}

const UINT64_MAX = (1n << 64n) - 1n;

/** Digit string → Uint<64> bigint, range-checked. */
export function amountToUint64(amountMinorUnits: string): bigint {
  if (!/^[0-9]+$/.test(amountMinorUnits)) {
    throw new DomainError("INVALID_IDENTIFIER", "amount must be digits", {});
  }
  const value = BigInt(amountMinorUnits);
  if (value > UINT64_MAX) {
    throw new DomainError("INVALID_IDENTIFIER", "amount exceeds Uint<64>", {});
  }
  return value;
}

/** Enforcement action → circuit action code (1 partial, 2 full). */
export function enforcementActionToCode(
  action: "partial-slash" | "full-slash",
): bigint {
  return action === "partial-slash" ? 1n : 2n;
}
