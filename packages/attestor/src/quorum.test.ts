import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { createQuorumConfig, DEFAULT_QUORUM_CONFIG } from "./policy.js";
import { evaluateQuorum } from "./quorum.js";
import type { CountedVerdict } from "./quorum.js";

const FRESH = "2026-10-02T00:00:00.000Z";
const EXPIRY = "2026-10-08T00:00:00.000Z";

function verdict(
  attestorId: string,
  verdictType: CountedVerdict["verdict"],
  issuedAt: string = FRESH,
): CountedVerdict {
  return {
    attestorId,
    verdict: verdictType,
    issuedAt,
    requestExpiresAt: EXPIRY,
  };
}

describe("quorum evaluation", () => {
  it("implements 2-of-3: any pair approves, singles do not", () => {
    const pairs = [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ];
    for (const [x, y] of pairs) {
      const result = evaluateQuorum(
        [verdict(x, "confirm"), verdict(y, "confirm")],
        DEFAULT_QUORUM_CONFIG,
      );
      expect(result.outcome).toBe("quorum-met");
      expect(result.confirms).toBe(2);
    }
    for (const single of ["a", "b", "c"]) {
      const result = evaluateQuorum(
        [verdict(single, "confirm")],
        DEFAULT_QUORUM_CONFIG,
      );
      expect(result.outcome).toBe("open");
    }
    expect(evaluateQuorum([], DEFAULT_QUORUM_CONFIG).outcome).toBe("open");
  });

  it("resolves the specified conflict triples deterministically", () => {
    // approve / reject / abstain → open (1 confirm, abstain neutral).
    expect(
      evaluateQuorum(
        [
          verdict("a", "confirm"),
          verdict("b", "reject"),
          verdict("c", "abstain"),
        ],
        DEFAULT_QUORUM_CONFIG,
      ).outcome,
    ).toBe("open");
    // approve / reject / approve → quorum-met.
    const ara = evaluateQuorum(
      [
        verdict("a", "confirm"),
        verdict("b", "reject"),
        verdict("c", "confirm"),
      ],
      DEFAULT_QUORUM_CONFIG,
    );
    expect(ara.outcome).toBe("quorum-met");
    expect(ara.confirms).toBe(2);
    expect(ara.rejects).toBe(1);
    // reject / reject / approve → rejected (2 rejects meet threshold).
    const rra = evaluateQuorum(
      [verdict("a", "reject"), verdict("b", "reject"), verdict("c", "confirm")],
      DEFAULT_QUORUM_CONFIG,
    );
    expect(rra.outcome).toBe("rejected");
    // all approve → quorum; all reject → rejected.
    expect(
      evaluateQuorum(
        [
          verdict("a", "confirm"),
          verdict("b", "confirm"),
          verdict("c", "confirm"),
        ],
        DEFAULT_QUORUM_CONFIG,
      ).outcome,
    ).toBe("quorum-met");
    expect(
      evaluateQuorum(
        [
          verdict("a", "reject"),
          verdict("b", "reject"),
          verdict("c", "reject"),
        ],
        DEFAULT_QUORUM_CONFIG,
      ).outcome,
    ).toBe("rejected");
  });

  it("generalizes to any valid N/M configuration", () => {
    const oneOfOne = createQuorumConfig(1, 1);
    expect(evaluateQuorum([verdict("a", "confirm")], oneOfOne).outcome).toBe(
      "quorum-met",
    );
    const threeOfFive = createQuorumConfig(3, 5);
    const two = evaluateQuorum(
      [verdict("a", "confirm"), verdict("b", "confirm")],
      threeOfFive,
    );
    expect(two.outcome).toBe("open");
    const three = evaluateQuorum(
      [
        verdict("a", "confirm"),
        verdict("b", "confirm"),
        verdict("c", "confirm"),
      ],
      threeOfFive,
    );
    expect(three.outcome).toBe("quorum-met");
  });

  it("rejects invalid quorum configurations", () => {
    for (const [required, total] of [
      [0, 3],
      [4, 3],
      [-1, 3],
      [1.5, 3],
    ]) {
      expect(() => createQuorumConfig(required, total)).toThrowError(
        DomainError,
      );
    }
  });

  it("counts each attestor once and excludes late verdicts", () => {
    const dupes = evaluateQuorum(
      [verdict("a", "confirm"), verdict("a", "confirm")],
      DEFAULT_QUORUM_CONFIG,
    );
    expect(dupes.confirms).toBe(1);
    expect(dupes.duplicatesSkipped).toEqual(["a"]);
    expect(dupes.outcome).toBe("open");
    const late = evaluateQuorum(
      [
        verdict("a", "confirm"),
        verdict("b", "confirm", "2026-11-01T00:00:00.000Z"),
      ],
      DEFAULT_QUORUM_CONFIG,
    );
    expect(late.confirms).toBe(1);
    expect(late.lateSkipped).toEqual(["b"]);
    expect(late.outcome).toBe("open");
  });
});
