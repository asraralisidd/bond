import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  parseAgentId,
  parseProtocolEventId,
  parseReputationId,
} from "./ids.js";
import {
  REPUTATION_MODEL_VERSION,
  deriveReputation,
  standingForScore,
} from "./reputation.js";
import type { DeriveReputationInput } from "./reputation.js";

function input(
  overrides: Partial<DeriveReputationInput["factors"]> = {},
): DeriveReputationInput {
  return {
    reputationId: parseReputationId("rep-001"),
    agentId: parseAgentId("agent-001"),
    factors: {
      confirmedFlags: 0,
      partialSlashes: 0,
      fullSlashes: 0,
      cleanBondsCompleted: 0,
      remediatedResolutions: 0,
      ...overrides,
    },
    triggeredByEvent: parseProtocolEventId("evt-001"),
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
}

describe("reputation domain", () => {
  it("scores a clean history at 100/good", () => {
    const record = deriveReputation(input({ cleanBondsCompleted: 3 }));
    expect(record.score).toBe(100);
    expect(record.standing).toBe("good");
    expect(record.modelVersion).toBe(REPUTATION_MODEL_VERSION);
  });

  it("penalizes confirmed violations and slashes deterministically", () => {
    const a = deriveReputation(input({ confirmedFlags: 2 }));
    expect(a.score).toBe(90);
    const b = deriveReputation(input({ partialSlashes: 1, confirmedFlags: 1 }));
    expect(b.score).toBe(85);
    const c = deriveReputation(input({ fullSlashes: 1 }));
    expect(c.score).toBe(75);
    // Deterministic: identical history replays to identical records.
    expect(deriveReputation(input({ fullSlashes: 1 }))).toEqual(c);
  });

  it("clamps at zero and degrades standing through the bands", () => {
    const ruined = deriveReputation(input({ fullSlashes: 10 }));
    expect(ruined.score).toBe(0);
    expect(ruined.standing).toBe("poor");
    expect(standingForScore(70)).toBe("good");
    expect(standingForScore(69)).toBe("probation");
    expect(standingForScore(40)).toBe("probation");
    expect(standingForScore(39)).toBe("poor");
  });

  it("partially restores standing on remediated resolutions", () => {
    const slashed = deriveReputation(input({ partialSlashes: 1 }));
    const remediated = deriveReputation(
      input({ partialSlashes: 1, remediatedResolutions: 1 }),
    );
    expect(remediated.score).toBeGreaterThan(slashed.score);
    // The slash stays on record: factors are never rewritten away.
    expect(remediated.factors.partialSlashes).toBe(1);
  });

  it("rejects negative factors and bad timestamps", () => {
    expect(() => deriveReputation(input({ confirmedFlags: -1 }))).toThrowError(
      DomainError,
    );
    expect(() =>
      deriveReputation({
        ...input(),
        updatedAt: "not-a-timestamp",
      }),
    ).toThrowError(DomainError);
  });
});
