import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import {
  flagAgent,
  processEnforcement,
  reactivateAgent,
  resolveAgent,
} from "./entrypoints.js";
import {
  AGENT,
  BOND,
  NOW,
  flaggedLedger,
  operatorCaller,
  partialDecision,
} from "./fixtures.js";

const ENFORCEMENT_CALLER = {
  kind: "enforcement",
  decisionId: "dec-001",
} as const;

describe("contract enforcement (slashing)", () => {
  it("executes a valid partial slash deterministically", () => {
    const { ledger, receipt } = processEnforcement(flaggedLedger(), {
      bondId: BOND,
      decision: partialDecision(),
      caller: ENFORCEMENT_CALLER,
      nowIso: NOW,
    });
    expect(receipt.slashedMinorUnits).toBe("2500");
    expect(receipt.isFullSlash).toBe(false);
    expect(ledger.bonds[BOND].status).toBe("PARTIALLY_SLASHED");
    expect(ledger.bonds[BOND].slashedTotalMinorUnits).toBe("2500");
    expect(ledger.agents[AGENT].status).toBe("SLASHED");
    expect(ledger.agents[AGENT].slashCount).toBe(1);
    expect(ledger.consumedEnforcementNullifiers).toEqual(["nullifier-001"]);
  });

  it("rejects replay: the same request cannot execute twice", () => {
    const first = processEnforcement(flaggedLedger(), {
      bondId: BOND,
      decision: partialDecision(),
      caller: ENFORCEMENT_CALLER,
      nowIso: NOW,
    });
    // Same nullifier, even under a new decision id → replay.
    try {
      processEnforcement(first.ledger, {
        bondId: BOND,
        decision: partialDecision({ decisionId: "dec-002" }),
        caller: { kind: "enforcement", decisionId: "dec-002" },
        nowIso: NOW,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("REPLAYED_ATTESTATION");
    }
    // A distinct valid request still processes (no over-blocking):
    // resolve → reactivate → re-flag, then enforce with a new nullifier.
    const backToService = flagAgent(
      reactivateAgent(
        resolveAgent(first.ledger, {
          agentId: AGENT,
          caller: operatorCaller(),
        }),
        { agentId: AGENT, caller: operatorCaller() },
      ),
      { agentId: AGENT, caller: operatorCaller() },
    );
    const second = processEnforcement(backToService, {
      bondId: BOND,
      decision: partialDecision({
        decisionId: "dec-002",
        nullifier: "nullifier-002",
        amountMinorUnits: "1000",
      }),
      caller: { kind: "enforcement", decisionId: "dec-002" },
      nowIso: NOW,
    });
    expect(second.ledger.bonds[BOND].slashedTotalMinorUnits).toBe("3500");
  });

  it("rejects unauthorized, cross-agent, and cross-finding enforcement", () => {
    const ledger = flaggedLedger();
    // Operator caller cannot invoke enforcement (invariant: no direct authority).
    expect(() =>
      processEnforcement(ledger, {
        bondId: BOND,
        decision: partialDecision(),
        caller: operatorCaller(),
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    // Decision for another agent fails subject binding.
    expect(() =>
      processEnforcement(ledger, {
        bondId: BOND,
        decision: partialDecision({ agentId: "agent-999" }),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    // Unknown bond fails.
    expect(() =>
      processEnforcement(ledger, {
        bondId: "bond-999",
        decision: partialDecision(),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects expired decisions and policy mismatches", () => {
    const ledger = flaggedLedger();
    expect(() =>
      processEnforcement(ledger, {
        bondId: BOND,
        decision: partialDecision({ expiresAt: "2026-09-01T00:00:00.000Z" }),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      processEnforcement(ledger, {
        bondId: BOND,
        decision: partialDecision({ policyVersion: "bond-policy-v999" }),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });

  it("exhausts to FULLY_SLASHED and rejects over-slash amounts", () => {
    const first = processEnforcement(flaggedLedger(), {
      bondId: BOND,
      decision: {
        ...partialDecision(),
        action: "full-slash",
        amountMinorUnits: undefined,
      },
      caller: ENFORCEMENT_CALLER,
      nowIso: NOW,
    });
    expect(first.receipt.isFullSlash).toBe(true);
    expect(first.receipt.slashedMinorUnits).toBe("10000");
    expect(first.ledger.bonds[BOND].status).toBe("FULLY_SLASHED");
    // Nothing left: further enforcement fails (also replay on same nullifier).
    expect(() =>
      processEnforcement(first.ledger, {
        bondId: BOND,
        decision: partialDecision({
          decisionId: "dec-002",
          nullifier: "nullifier-002",
          amountMinorUnits: "1",
        }),
        caller: { kind: "enforcement", decisionId: "dec-002" },
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
    // Over-range amount rejected on a fresh ledger.
    expect(() =>
      processEnforcement(flaggedLedger(), {
        bondId: BOND,
        decision: partialDecision({ amountMinorUnits: "99999" }),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });

  it("never trusts a risk result: no flag-only path to enforcement", () => {
    // processEnforcement has no parameter slot for a RiskFlag or engine
    // output — only a bound attested decision. Static scan in
    // boundary.test.ts proves the absence; here we prove behavior: an
    // unknown agent (flag or no flag) cannot be slashed.
    expect(() =>
      processEnforcement(flaggedLedger(), {
        bondId: BOND,
        decision: partialDecision({ agentId: "ghost-agent" }),
        caller: ENFORCEMENT_CALLER,
        nowIso: NOW,
      }),
    ).toThrowError(DomainError);
  });
});
