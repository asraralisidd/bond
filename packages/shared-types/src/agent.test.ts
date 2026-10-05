import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  canTransitionAgent,
  isTerminalAgentStatus,
  transitionAgentStatus,
} from "./agent.js";
import type { AgentStatus } from "./enums.js";

describe("agent state machine", () => {
  it("walks the happy path UNREGISTERED → … → WITHDRAWABLE", () => {
    const path: AgentStatus[] = [
      "UNREGISTERED",
      "REGISTERED",
      "BONDED",
      "ELIGIBLE",
      "ACTIVE",
      "WITHDRAWABLE",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionAgent(path[i], path[i + 1])).toBe(true);
      expect(transitionAgentStatus(path[i], path[i + 1])).toBe(path[i + 1]);
    }
  });

  it("supports the flag → enforcement → resolution cycle", () => {
    expect(transitionAgentStatus("ACTIVE", "FLAGGED")).toBe("FLAGGED");
    // Attestation itself lives on the decision record (no ATTESTED state here).
    expect(transitionAgentStatus("FLAGGED", "SLASHED")).toBe("SLASHED");
    expect(transitionAgentStatus("SLASHED", "RESOLVED")).toBe("RESOLVED");
    expect(transitionAgentStatus("RESOLVED", "ACTIVE")).toBe("ACTIVE");
  });

  it("supports flag dismissal and suspension round-trips", () => {
    expect(transitionAgentStatus("FLAGGED", "RESOLVED")).toBe("RESOLVED");
    expect(transitionAgentStatus("ACTIVE", "SUSPENDED")).toBe("SUSPENDED");
    expect(transitionAgentStatus("SUSPENDED", "ACTIVE")).toBe("ACTIVE");
    expect(transitionAgentStatus("FLAGGED", "SUSPENDED")).toBe("SUSPENDED");
    expect(transitionAgentStatus("SUSPENDED", "FLAGGED")).toBe("FLAGGED");
  });

  it("treats WITHDRAWABLE as terminal (new bond starts a new lifecycle)", () => {
    expect(isTerminalAgentStatus("WITHDRAWABLE")).toBe(true);
    expect(isTerminalAgentStatus("ACTIVE")).toBe(false);
    const targets: AgentStatus[] = [
      "ACTIVE",
      "REGISTERED",
      "BONDED",
      "RESOLVED",
    ];
    for (const to of targets) {
      expect(canTransitionAgent("WITHDRAWABLE", to)).toBe(false);
    }
  });

  it("rejects Phase 0 invalid transitions", () => {
    const invalid: Array<[AgentStatus, AgentStatus]> = [
      ["UNREGISTERED", "ACTIVE"],
      ["UNREGISTERED", "BONDED"],
      ["REGISTERED", "ELIGIBLE"],
      ["REGISTERED", "ACTIVE"],
      ["SLASHED", "ACTIVE"],
      ["WITHDRAWABLE", "ACTIVE"],
      ["REGISTERED", "REGISTERED"],
      ["ACTIVE", "REGISTERED"],
      ["BONDED", "ACTIVE"],
    ];
    for (const [from, to] of invalid) {
      expect(canTransitionAgent(from, to)).toBe(false);
      try {
        transitionAgentStatus(from, to);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        const domainError = error as DomainError;
        expect(domainError.code).toBe("INVALID_AGENT_TRANSITION");
        expect(domainError.details).toMatchObject({ from, to });
      }
    }
  });

  it("is deterministic: same input always yields the same output", () => {
    expect(transitionAgentStatus("BONDED", "ELIGIBLE")).toBe(
      transitionAgentStatus("BONDED", "ELIGIBLE"),
    );
  });
});
