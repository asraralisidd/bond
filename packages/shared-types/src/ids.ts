/**
 * Branded domain identifiers.
 *
 * Each ID is a string at runtime with a compile-time brand so IDs from
 * different domains cannot be accidentally mixed (e.g. passing a BondId
 * where an AgentId is expected is a type error).
 *
 * IDs are validated (never generated) here: generation is infrastructure
 * (UUIDs, DB sequences) and out of scope for Phase 1. Use `parseXId` to
 * validate external input; it throws a DomainError on invalid values.
 */
import { DomainError } from "./errors.js";

declare const BRAND: unique symbol;

export type Brand<T extends string, B extends string> = T & {
  readonly [BRAND]: B;
};

export type OperatorId = Brand<string, "OperatorId">;
export type AgentId = Brand<string, "AgentId">;
export type BondId = Brand<string, "BondId">;
export type RiskFlagId = Brand<string, "RiskFlagId">;
export type AttestationId = Brand<string, "AttestationId">;
export type SlashEventId = Brand<string, "SlashEventId">;
export type ReputationId = Brand<string, "ReputationId">;
export type ProtocolEventId = Brand<string, "ProtocolEventId">;
export type TransactionId = Brand<string, "TransactionId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type AttestorId = Brand<string, "AttestorId">;
export type DecisionId = Brand<string, "DecisionId">;

const MAX_ID_LENGTH = 128;

function parseBranded<B extends string>(
  brand: B,
  value: unknown,
): Brand<string, B> {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `Invalid ${brand}: empty`, {
      brand,
    });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new DomainError("INVALID_IDENTIFIER", `Invalid ${brand}: too long`, {
      brand,
    });
  }
  return value as Brand<string, B>;
}

export function parseOperatorId(value: unknown): OperatorId {
  return parseBranded("OperatorId", value);
}

export function parseAgentId(value: unknown): AgentId {
  return parseBranded("AgentId", value);
}

export function parseBondId(value: unknown): BondId {
  return parseBranded("BondId", value);
}

export function parseRiskFlagId(value: unknown): RiskFlagId {
  return parseBranded("RiskFlagId", value);
}

export function parseAttestationId(value: unknown): AttestationId {
  return parseBranded("AttestationId", value);
}

export function parseSlashEventId(value: unknown): SlashEventId {
  return parseBranded("SlashEventId", value);
}

export function parseReputationId(value: unknown): ReputationId {
  return parseBranded("ReputationId", value);
}

export function parseProtocolEventId(value: unknown): ProtocolEventId {
  return parseBranded("ProtocolEventId", value);
}

export function parseTransactionId(value: unknown): TransactionId {
  return parseBranded("TransactionId", value);
}

export function parseEvidenceId(value: unknown): EvidenceId {
  return parseBranded("EvidenceId", value);
}

export function parseAttestorId(value: unknown): AttestorId {
  return parseBranded("AttestorId", value);
}

export function parseDecisionId(value: unknown): DecisionId {
  return parseBranded("DecisionId", value);
}
