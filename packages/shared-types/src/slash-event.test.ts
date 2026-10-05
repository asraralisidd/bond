import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  parseAgentId,
  parseAttestationId,
  parseBondId,
  parseDecisionId,
  parseRiskFlagId,
  parseSlashEventId,
} from "./ids.js";
import { completeSlashEvent, createSlashEvent } from "./slash-event.js";
import type { CreateSlashEventInput } from "./slash-event.js";

function validInput(): CreateSlashEventInput {
  return {
    slashEventId: parseSlashEventId("slash-001"),
    agentId: parseAgentId("agent-001"),
    bondId: parseBondId("bond-001"),
    attestationId: parseAttestationId("att-001"),
    decisionId: parseDecisionId("dec-001"),
    riskFlagId: parseRiskFlagId("flag-001"),
    category: "unauthorized-action",
    severity: "high",
    slashedMinorUnits: "250000",
    isFullSlash: false,
    initiatedAt: "2026-10-05T00:00:00.000Z",
  };
}

describe("slash event domain", () => {
  it("constructs an initiated event with all required references", () => {
    const event = createSlashEvent(validInput());
    expect(event.status).toBe("initiated");
    expect(event.completedAt).toBeNull();
    expect(event.attestationId).toBe("att-001");
    expect(event.decisionId).toBe("dec-001");
    expect(event.riskFlagId).toBe("flag-001");
  });

  it("requires an amount and a valid timestamp", () => {
    expect(() =>
      createSlashEvent({ ...validInput(), slashedMinorUnits: "" }),
    ).toThrowError(DomainError);
    expect(() =>
      createSlashEvent({ ...validInput(), initiatedAt: "yesterday" }),
    ).toThrowError(DomainError);
  });

  it("completes exactly once and is then immutable", () => {
    const initiated = createSlashEvent(validInput());
    const completed = completeSlashEvent(initiated, "2026-10-05T01:00:00.000Z");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe("2026-10-05T01:00:00.000Z");
    // Original is untouched (immutable data).
    expect(initiated.status).toBe("initiated");
    expect(() =>
      completeSlashEvent(completed, "2026-10-05T02:00:00.000Z"),
    ).toThrowError(DomainError);
  });
});
