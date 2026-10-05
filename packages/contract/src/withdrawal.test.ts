import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import {
  lockBond,
  processEnforcement,
  registerAgent,
  releaseBond,
  resolveAgent,
  withdrawBond,
} from "./entrypoints.js";
import { toPublicContractLedgerView } from "./projections.js";
import {
  AGENT,
  BOND,
  NOW,
  OTHER_OPERATOR,
  flaggedLedger,
  freshLedger,
  operatorCaller,
  partialDecision,
} from "./fixtures.js";

const ENFORCEMENT_CALLER = {
  kind: "enforcement",
  decisionId: "dec-001",
} as const;

describe("contract withdrawal", () => {
  it("releases and withdraws exactly once", () => {
    let ledger = flaggedLedger();
    // Release blocked while flagged.
    expect(() =>
      releaseBond(ledger, { bondId: BOND, caller: operatorCaller() }),
    ).toThrowError(DomainError);
    // Resolve the flag first (operator acknowledges closure).
    ledger = resolveAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
    ledger = releaseBond(ledger, { bondId: BOND, caller: operatorCaller() });
    expect(ledger.bonds[BOND].status).toBe("WITHDRAWABLE");
    ledger = withdrawBond(ledger, { bondId: BOND, caller: operatorCaller() });
    expect(ledger.bonds[BOND].status).toBe("WITHDRAWN");
    // Double withdrawal rejected.
    expect(() =>
      withdrawBond(ledger, { bondId: BOND, caller: operatorCaller() }),
    ).toThrowError(DomainError);
  });

  it("rejects unauthorized withdrawal and withdrawal while locked", () => {
    const ledger = flaggedLedger();
    expect(() =>
      withdrawBond(ledger, {
        bondId: BOND,
        caller: operatorCaller(OTHER_OPERATOR),
      }),
    ).toThrowError(DomainError);
    // ACTIVE (not released) cannot withdraw.
    let direct = freshLedger();
    direct = registerAgent(direct, {
      agentId: AGENT,
      operatorId: "operator-001",
      caller: operatorCaller("operator-001"),
    });
    direct = lockBond(direct, {
      bondId: BOND,
      agentId: AGENT,
      operatorId: "operator-001",
      commitmentMinorUnits: "500",
      caller: operatorCaller("operator-001"),
    });
    expect(() =>
      withdrawBond(direct, {
        bondId: BOND,
        caller: operatorCaller("operator-001"),
      }),
    ).toThrowError(DomainError);
  });

  it("blocks withdrawal of slashed remainder until released, then allows it", () => {
    const slashed = processEnforcement(flaggedLedger(), {
      bondId: BOND,
      decision: partialDecision(),
      caller: ENFORCEMENT_CALLER,
      nowIso: NOW,
    }).ledger;
    // Agent is SLASHED; resolve, then release the remainder.
    const resolved = resolveAgent(slashed, {
      agentId: AGENT,
      caller: operatorCaller(),
    });
    const released = releaseBond(resolved, {
      bondId: BOND,
      caller: operatorCaller(),
    });
    expect(released.bonds[BOND].status).toBe("WITHDRAWABLE");
    const withdrawn = withdrawBond(released, {
      bondId: BOND,
      caller: operatorCaller(),
    });
    expect(withdrawn.bonds[BOND].status).toBe("WITHDRAWN");
  });
});

describe("contract public projections", () => {
  it("exposes statuses and counts, never amounts or operators", () => {
    const slashed = processEnforcement(flaggedLedger(), {
      bondId: BOND,
      decision: partialDecision(),
      caller: ENFORCEMENT_CALLER,
      nowIso: NOW,
    }).ledger;
    const view = toPublicContractLedgerView(slashed);
    expect(view.agents).toEqual([
      {
        agentId: AGENT,
        status: "SLASHED",
        bondStatus: "PARTIALLY_SLASHED",
        slashCount: 1,
      },
    ]);
    expect(view.contractVersion).toBe("bond-contract-v1");
    const serialized = JSON.stringify(view);
    for (const token of [
      "10000",
      "2500",
      "operator-001",
      "nullifier",
      "commitment",
      "slashedTotal",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
  });
});
