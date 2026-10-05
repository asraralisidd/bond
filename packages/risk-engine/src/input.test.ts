import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { normalizeActivity } from "./input.js";
import type { RawActivityInput } from "./input.js";

function validRaw(): RawActivityInput {
  return {
    activityId: "act-001",
    agentId: "agent-001",
    occurredAt: "2026-10-01T12:00:00.000Z",
    actionType: "tool-call",
    action: "read-file",
    tool: "fs-read",
    metadata: { path: "/tmp/report.md", retries: 0, cached: false },
    policyContext: {
      policyVersion: "policy v3",
      allowedActions: ["read-file"],
      declaredTools: ["fs-read"],
    },
  };
}

describe("input normalization", () => {
  it("normalizes valid input deterministically", () => {
    const a = normalizeActivity(validRaw());
    const b = normalizeActivity(validRaw());
    expect(a).toEqual(b);
    expect(a.tool).toBe("fs-read");
    expect(a.redactedFields).toEqual([]);
    // Canonical key order in metadata.
    expect(Object.keys(a.metadata)).toEqual(["cached", "path", "retries"]);
  });

  it("rejects missing/invalid required fields", () => {
    expect(() => normalizeActivity({ ...validRaw(), activityId: "" })).toThrow(
      DomainError,
    );
    expect(() =>
      normalizeActivity({ ...validRaw(), occurredAt: "soon" }),
    ).toThrow(DomainError);
    expect(() =>
      normalizeActivity({ ...validRaw(), actionType: "teleport" }),
    ).toThrow(DomainError);
    expect(() => normalizeActivity({ ...validRaw(), action: "  " })).toThrow(
      DomainError,
    );
    try {
      normalizeActivity({ ...validRaw(), agentId: "" });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("INVALID_IDENTIFIER");
    }
  });

  it("redacts secret-like metadata keys and drops non-primitives", () => {
    const normalized = normalizeActivity({
      ...validRaw(),
      metadata: {
        api_key: "sk-SECRET-001",
        password: "hunter2",
        authToken: "tok-SECRET-002",
        nested: { deep: "object" },
        tags: ["a", "b"],
        safe: "visible",
      },
    });
    expect(normalized.redactedFields).toEqual([
      "api_key",
      "authToken",
      "nested",
      "password",
      "tags",
    ]);
    expect(normalized.metadata).toEqual({ safe: "visible" });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("sk-SECRET-001");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("tok-SECRET-002");
  });

  it("truncates long text and defaults absent optionals", () => {
    const normalized = normalizeActivity({
      ...validRaw(),
      textSnippet: "x".repeat(2000),
    });
    expect(normalized.textSnippet?.length).toBe(500);
    expect(normalized.amountMinorUnits).toBeNull();
    expect(normalized.bytesOut).toBeNull();
    expect(normalized.externalDestination).toBe(false);
    expect(normalized.reporterSeverity).toBeNull();
  });
});
