import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import {
  agentStatusFromCode,
  agentStatusToCode,
  amountToUint64,
  bondStatusFromCode,
  bondStatusToCode,
  domainIdToBytes32,
  enforcementActionToCode,
  nullifierToBytes32,
} from "./encoding.js";

describe("domain ↔ Compact encoding", () => {
  it("maps agent statuses both directions", () => {
    const statuses = [
      "REGISTERED",
      "BONDED",
      "ACTIVE",
      "FLAGGED",
      "SLASHED",
      "RESOLVED",
    ] as const;
    for (const status of statuses) {
      expect(agentStatusFromCode(agentStatusToCode(status))).toBe(status);
    }
    expect(agentStatusToCode("REGISTERED")).toBe(1n);
    expect(agentStatusToCode("RESOLVED")).toBe(6n);
    expect(() => agentStatusFromCode(0n)).toThrowError(DomainError);
    expect(() => agentStatusFromCode(7n)).toThrowError(DomainError);
  });

  it("maps bond statuses both directions", () => {
    const statuses = [
      "ACTIVE",
      "LOCKED",
      "PARTIALLY_SLASHED",
      "FULLY_SLASHED",
      "WITHDRAWABLE",
      "WITHDRAWN",
      "CANCELLED",
    ] as const;
    for (const status of statuses) {
      expect(bondStatusFromCode(bondStatusToCode(status))).toBe(status);
    }
    expect(() => bondStatusFromCode(0n)).toThrowError(DomainError);
    expect(() => bondStatusFromCode(8n)).toThrowError(DomainError);
  });

  it("derives deterministic 32-byte keys from domain IDs", () => {
    const a = domainIdToBytes32("agent-001");
    const b = domainIdToBytes32("agent-001");
    const c = domainIdToBytes32("agent-002");
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(
      Buffer.from(c).toString("hex"),
    );
    expect(() => domainIdToBytes32("")).toThrowError(DomainError);
    const n = nullifierToBytes32("nullifier-001");
    expect(n.length).toBe(32);
    expect(Buffer.from(n).toString("hex")).not.toBe(
      Buffer.from(domainIdToBytes32("nullifier-001")).toString("hex"),
    );
  });

  it("validates amounts and action codes", () => {
    expect(amountToUint64("10000")).toBe(10000n);
    expect(amountToUint64("0")).toBe(0n);
    expect(() => amountToUint64("10.5")).toThrowError(DomainError);
    expect(() => amountToUint64("-1")).toThrowError(DomainError);
    expect(() => amountToUint64("")).toThrowError(DomainError);
    expect(() => amountToUint64("18446744073709551616")).toThrowError(
      DomainError,
    );
    expect(enforcementActionToCode("partial-slash")).toBe(1n);
    expect(enforcementActionToCode("full-slash")).toBe(2n);
  });
});
