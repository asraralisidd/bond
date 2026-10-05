import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { parseAgentId, parseEvidenceId, parseRiskFlagId } from "./ids.js";
import {
  canTransitionRiskFlag,
  createRiskFlag,
  transitionRiskFlagStatus,
} from "./risk-flag.js";
import type { CreateRiskFlagInput } from "./risk-flag.js";

function validInput(): CreateRiskFlagInput {
  return {
    riskFlagId: parseRiskFlagId("flag-001"),
    agentId: parseAgentId("agent-001"),
    category: "unauthorized-action",
    severity: "high",
    confidence: 0.82,
    evidenceRefs: [
      {
        evidenceId: parseEvidenceId("ev-001"),
        category: "tool-call-log",
        contentHash: "hash:opaque-001",
      },
    ],
    detectedAt: "2026-10-01T00:00:00.000Z",
    modelVersion: "risk-scorer v0.3.1 / config c12",
  };
}

describe("risk flag domain", () => {
  it("constructs a valid advisory flag starting open", () => {
    const flag = createRiskFlag(validInput());
    expect(flag.status).toBe("open");
    expect(flag.confidence).toBe(0.82);
    expect(flag.supersedes).toBeNull();
  });

  it("rejects confidence outside [0, 1]", () => {
    for (const confidence of [-0.1, 1.1, Number.NaN]) {
      try {
        createRiskFlag({ ...validInput(), confidence });
        expect.unreachable();
      } catch (error) {
        expect((error as DomainError).code).toBe("INVALID_RISK_FLAG");
      }
    }
  });

  it("requires evidence, model version, and valid timestamps", () => {
    expect(() =>
      createRiskFlag({ ...validInput(), evidenceRefs: [] }),
    ).toThrowError(DomainError);
    expect(() =>
      createRiskFlag({ ...validInput(), modelVersion: "" }),
    ).toThrowError(DomainError);
    expect(() =>
      createRiskFlag({ ...validInput(), detectedAt: "not-a-date" }),
    ).toThrowError(DomainError);
  });

  it("transitions open → under-review → attested, and supports dismissal/expiry", () => {
    const flag = createRiskFlag(validInput());
    const review = transitionRiskFlagStatus(flag, "under-review");
    expect(review.status).toBe("under-review");
    expect(transitionRiskFlagStatus(review, "attested").status).toBe(
      "attested",
    );
    expect(transitionRiskFlagStatus(flag, "dismissed").status).toBe(
      "dismissed",
    );
    expect(transitionRiskFlagStatus(flag, "expired").status).toBe("expired");
    expect(canTransitionRiskFlag("attested", "open")).toBe(false);
    expect(() => transitionRiskFlagStatus(review, "open")).toThrowError(
      DomainError,
    );
  });

  it("is advisory-only: serializes to data with no behavior or chain surface", () => {
    const flag = createRiskFlag(validInput());
    // Only expected data keys exist — no sign/submit/execute capability.
    expect(Object.keys(flag).sort()).toEqual(
      [
        "agentId",
        "category",
        "confidence",
        "detectedAt",
        "evidenceRefs",
        "modelVersion",
        "riskFlagId",
        "severity",
        "status",
        "supersedes",
      ].sort(),
    );
    // JSON round-trip preserves the flag (deterministic, serializable).
    expect(JSON.parse(JSON.stringify(flag))).toEqual(flag);
  });
});
