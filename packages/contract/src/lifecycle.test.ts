import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import {
  activateAgent,
  flagAgent,
  lockBond,
  reactivateAgent,
  registerAgent,
  resolveAgent,
} from "./entrypoints.js";
import {
  AGENT,
  BOND,
  OPERATOR,
  OTHER_AGENT,
  OTHER_OPERATOR,
  freshLedger,
  operatorCaller,
} from "./fixtures.js";

describe("contract registration and bonding", () => {
  it("registers an agent and locks a bond (invariant: no duplicate registration)", () => {
    let ledger = freshLedger();
    ledger = registerAgent(ledger, {
      agentId: AGENT,
      operatorId: OPERATOR,
      caller: operatorCaller(),
    });
    expect(ledger.agents[AGENT].status).toBe("REGISTERED");
    expect(() =>
      registerAgent(ledger, {
        agentId: AGENT,
        operatorId: OPERATOR,
        caller: operatorCaller(),
      }),
    ).toThrowError(DomainError);
    ledger = lockBond(ledger, {
      bondId: BOND,
      agentId: AGENT,
      operatorId: OPERATOR,
      commitmentMinorUnits: "10000",
      caller: operatorCaller(),
    });
    expect(ledger.bonds[BOND].status).toBe("ACTIVE");
    expect(ledger.agents[AGENT].status).toBe("BONDED");
  });

  it("rejects unauthorized mutation of another operator's agent", () => {
    let ledger = freshLedger();
    ledger = registerAgent(ledger, {
      agentId: AGENT,
      operatorId: OPERATOR,
      caller: operatorCaller(),
    });
    // Wrong caller claims ownership.
    expect(() =>
      lockBond(ledger, {
        bondId: BOND,
        agentId: AGENT,
        operatorId: OTHER_OPERATOR,
        commitmentMinorUnits: "100",
        caller: operatorCaller(OTHER_OPERATOR),
      }),
    ).toThrowError(DomainError);
    expect(ledger.agents[AGENT].bondId).toBeNull();
  });

  it("rejects invalid, zero, and duplicate bonds", () => {
    let ledger = freshLedger();
    ledger = registerAgent(ledger, {
      agentId: AGENT,
      operatorId: OPERATOR,
      caller: operatorCaller(),
    });
    for (const bad of ["0", "abc", "-5", "10.5", ""]) {
      expect(() =>
        lockBond(ledger, {
          bondId: BOND,
          agentId: AGENT,
          operatorId: OPERATOR,
          commitmentMinorUnits: bad,
          caller: operatorCaller(),
        }),
      ).toThrowError(DomainError);
    }
    ledger = lockBond(ledger, {
      bondId: BOND,
      agentId: AGENT,
      operatorId: OPERATOR,
      commitmentMinorUnits: "100",
      caller: operatorCaller(),
    });
    // Second active bond for the same agent is rejected.
    expect(() =>
      lockBond(ledger, {
        bondId: "bond-002",
        agentId: AGENT,
        operatorId: OPERATOR,
        commitmentMinorUnits: "100",
        caller: operatorCaller(),
      }),
    ).toThrowError(DomainError);
  });

  it("walks BONDED → ACTIVE → FLAGGED → RESOLVED and rejects bad moves", () => {
    let ledger = freshLedger();
    ledger = registerAgent(ledger, {
      agentId: AGENT,
      operatorId: OPERATOR,
      caller: operatorCaller(),
    });
    ledger = lockBond(ledger, {
      bondId: BOND,
      agentId: AGENT,
      operatorId: OPERATOR,
      commitmentMinorUnits: "100",
      caller: operatorCaller(),
    });
    ledger = activateAgent(ledger, {
      agentId: AGENT,
      caller: operatorCaller(),
    });
    expect(ledger.agents[AGENT].status).toBe("ACTIVE");
    ledger = flagAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
    expect(ledger.agents[AGENT].status).toBe("FLAGGED");
    ledger = resolveAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
    expect(ledger.agents[AGENT].status).toBe("RESOLVED");
    // No backwards moves: RESOLVED cannot re-flag or re-activate.
    expect(() =>
      flagAgent(ledger, { agentId: AGENT, caller: operatorCaller() }),
    ).toThrowError(DomainError);
    // Unknown agents have no transitions (absence = UNREGISTERED).
    expect(() =>
      flagAgent(ledger, { agentId: OTHER_AGENT, caller: operatorCaller() }),
    ).toThrowError(DomainError);
  });

  it("reactivates RESOLVED agents backed by a live bond", () => {
    let ledger = freshLedger();
    ledger = registerAgent(ledger, {
      agentId: AGENT,
      operatorId: OPERATOR,
      caller: operatorCaller(),
    });
    ledger = lockBond(ledger, {
      bondId: BOND,
      agentId: AGENT,
      operatorId: OPERATOR,
      commitmentMinorUnits: "100",
      caller: operatorCaller(),
    });
    ledger = flagAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
    ledger = resolveAgent(ledger, { agentId: AGENT, caller: operatorCaller() });
    ledger = reactivateAgent(ledger, {
      agentId: AGENT,
      caller: operatorCaller(),
    });
    expect(ledger.agents[AGENT].status).toBe("ACTIVE");
    // Only RESOLVED reactivates: ACTIVE cannot re-enter itself.
    expect(() =>
      reactivateAgent(ledger, { agentId: AGENT, caller: operatorCaller() }),
    ).toThrowError(DomainError);
  });
});
