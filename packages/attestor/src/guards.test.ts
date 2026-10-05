import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { verifyEvidenceCoverage, verifySubjectBinding } from "./binding.js";
import { assertVerdictFresh, isFresh } from "./freshness.js";
import { assertNotReplayed, markConsumed } from "./replay.js";

const EXPIRY = "2026-10-08T00:00:00.000Z";

describe("freshness", () => {
  it("accepts fresh, rejects boundary and expired instants", () => {
    expect(isFresh(EXPIRY, "2026-10-02T00:00:00.000Z")).toBe(true);
    // Exactly at the boundary counts as expired — no racing expiry.
    expect(isFresh(EXPIRY, EXPIRY)).toBe(false);
    expect(isFresh(EXPIRY, "2026-11-01T00:00:00.000Z")).toBe(false);
  });

  it("rejects late verdicts and bad timestamps", () => {
    expect(() =>
      assertVerdictFresh("2026-11-01T00:00:00.000Z", EXPIRY),
    ).toThrowError(DomainError);
    expect(() => assertVerdictFresh(EXPIRY, EXPIRY)).toThrowError(DomainError);
    assertVerdictFresh("2026-10-02T00:00:00.000Z", EXPIRY);
    expect(() => isFresh("not-a-date", EXPIRY)).toThrowError(DomainError);
  });
});

describe("replay protection", () => {
  it("accepts first use and rejects the second", () => {
    const empty = new Set<string>();
    assertNotReplayed("nullifier-001", empty, "test");
    const consumed = markConsumed("nullifier-001", empty);
    expect(consumed.has("nullifier-001")).toBe(true);
    expect(empty.has("nullifier-001")).toBe(false);
    try {
      assertNotReplayed("nullifier-001", consumed, "test");
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("REPLAYED_ATTESTATION");
    }
    // Distinct keys are independent.
    assertNotReplayed("nullifier-002", consumed, "test");
    expect(() => assertNotReplayed("", consumed, "test")).toThrowError(
      DomainError,
    );
  });
});

describe("subject and evidence binding", () => {
  it("accepts the correct subject and rejects cross-agent reuse", () => {
    verifySubjectBinding(
      { agentId: "agent-001", riskFlagId: "flag-001" },
      { agentId: "agent-001", riskFlagId: "flag-001" },
    );
    try {
      verifySubjectBinding(
        { agentId: "agent-001", riskFlagId: "flag-001" },
        { agentId: "agent-002", riskFlagId: "flag-001" },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("INVALID_ATTESTATION");
    }
  });

  it("rejects cross-finding reuse and uncovered evidence", () => {
    expect(() =>
      verifySubjectBinding(
        { agentId: "agent-001", riskFlagId: "flag-001" },
        { agentId: "agent-001", riskFlagId: "flag-002" },
      ),
    ).toThrowError(DomainError);
    // Full coverage passes; extras permitted; gaps rejected.
    verifyEvidenceCoverage(["ev-001"], ["ev-001", "ev-002"]);
    expect(() => verifyEvidenceCoverage(["ev-001"], ["ev-002"])).toThrowError(
      DomainError,
    );
    expect(() => verifyEvidenceCoverage(["ev-001"], [])).toThrowError(
      DomainError,
    );
  });
});
