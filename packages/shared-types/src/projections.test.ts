import { describe, expect, it } from "vitest";
import {
  parseAgentId,
  parseAttestationId,
  parseBondId,
  parseDecisionId,
  parseOperatorId,
  parseProtocolEventId,
  parseReputationId,
  parseRiskFlagId,
  parseSlashEventId,
} from "./ids.js";
import type { Agent } from "./agent.js";
import type { Bond } from "./bond.js";
import type { ReputationRecord } from "./reputation.js";
import type { SlashEvent } from "./slash-event.js";
import {
  countOpenFlags,
  toPublicAgentView,
  toPublicBondView,
  toPublicReputationView,
  toPublicSlashRecord,
  verifyAgentPublic,
} from "./projections.js";

const SECRET_AMOUNT = "SECRET-AMOUNT-987654321";
const SECRET_HASH = "SECRET-EVIDENCE-HASH-abcdef";
const SECRET_OPERATOR = "SECRET-OPERATOR-PII";

function agent(): Agent {
  return {
    agentId: parseAgentId("agent-001"),
    operatorId: parseOperatorId(SECRET_OPERATOR),
    platform: "langchain",
    agentType: "workflow",
    capabilities: ["read-only"],
    externalRef: "ext-ref-001",
    status: "ACTIVE",
    registeredAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function bond(): Bond {
  return {
    bondId: parseBondId("bond-001"),
    agentId: parseAgentId("agent-001"),
    operatorId: parseOperatorId(SECRET_OPERATOR),
    commitment: {
      amountMinorUnits: SECRET_AMOUNT,
      denomination: "X",
    },
    policyVersion: "policy v3",
    status: "ACTIVE",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function reputation(): ReputationRecord {
  return {
    reputationId: parseReputationId("rep-001"),
    agentId: parseAgentId("agent-001"),
    score: 95,
    standing: "good",
    factors: {
      confirmedFlags: 1,
      partialSlashes: 0,
      fullSlashes: 0,
      cleanBondsCompleted: 2,
      remediatedResolutions: 0,
    },
    triggeredByEvent: parseProtocolEventId("evt-001"),
    modelVersion: "v0",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function slash(): SlashEvent {
  return {
    slashEventId: parseSlashEventId("slash-001"),
    agentId: parseAgentId("agent-001"),
    bondId: parseBondId("bond-001"),
    attestationId: parseAttestationId("att-001"),
    decisionId: parseDecisionId("dec-001"),
    riskFlagId: parseRiskFlagId("flag-001"),
    category: "overspend",
    severity: "medium",
    slashedMinorUnits: SECRET_AMOUNT,
    isFullSlash: false,
    status: "completed",
    transactionId: null,
    initiatedAt: "2026-10-05T00:00:00.000Z",
    completedAt: "2026-10-05T01:00:00.000Z",
  };
}

describe("public projections (privacy boundary)", () => {
  it("exposes only allowlisted agent fields", () => {
    const view = toPublicAgentView({
      agent: agent(),
      reputationStanding: "good",
      bondStatus: "ACTIVE",
      openFlagCount: 0,
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        "agentId",
        "agentType",
        "bondStatus",
        "isActive",
        "openFlagCount",
        "platform",
        "registrationStatus",
        "reputationStanding",
      ].sort(),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SECRET_OPERATOR);
    expect(serialized).not.toContain("externalRef");
  });

  it("never exposes bond amounts or operator identity", () => {
    const view = toPublicBondView(bond());
    expect(view).toEqual({ status: "ACTIVE", policyVersion: "policy v3" });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SECRET_AMOUNT);
    expect(serialized).not.toContain(SECRET_OPERATOR);
    expect(serialized).not.toContain("amountMinorUnits");
    expect(serialized).not.toContain("commitment");
  });

  it("exposes reputation bands and counts, never internals", () => {
    const view = toPublicReputationView(reputation());
    expect(view.standing).toBe("good");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("score");
    expect(serialized).not.toContain("reputationId");
    expect(serialized).not.toContain("triggeredByEvent");
  });

  it("exposes slash bands, never exact amounts", () => {
    const view = toPublicSlashRecord(slash());
    expect(view).toEqual({
      slashEventId: "slash-001",
      band: "partial",
      severity: "medium",
      completedAt: "2026-10-05T01:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain(SECRET_AMOUNT);
    expect(JSON.stringify(view)).not.toContain("slashedMinorUnits");
  });

  it("keeps evidence hashes out of every public view", () => {
    const views = [
      toPublicAgentView({
        agent: agent(),
        reputationStanding: "good",
        bondStatus: "ACTIVE",
        openFlagCount: 1,
      }),
      toPublicBondView(bond()),
      toPublicReputationView(reputation()),
      toPublicSlashRecord(slash()),
    ];
    for (const view of views) {
      expect(JSON.stringify(view)).not.toContain(SECRET_HASH);
      expect(JSON.stringify(view)).not.toContain("contentHash");
    }
  });

  it("computes verification verdicts deterministically", () => {
    const base = {
      agentId: "agent-001",
      registrationStatus: "ACTIVE" as const,
      bondStatus: "ACTIVE" as const,
      reputationStanding: "good" as const,
      completedSlashCount: 0,
      openFlagCount: 0,
      asOf: "2026-10-06T00:00:00.000Z",
      policyVersion: "policy v3",
    };
    expect(verifyAgentPublic(base).result).toBe("trusted");
    expect(verifyAgentPublic({ ...base, openFlagCount: 1 }).result).toBe(
      "caution",
    );
    expect(verifyAgentPublic({ ...base, completedSlashCount: 1 }).result).toBe(
      "caution",
    );
    expect(
      verifyAgentPublic({
        ...base,
        bondStatus: "FULLY_SLASHED",
        reputationStanding: "poor",
      }).result,
    ).toBe("untrusted");
    // Soundness over completeness: unbonded agents are never "trusted".
    expect(
      verifyAgentPublic({ ...base, registrationStatus: "REGISTERED" }).result,
    ).toBe("caution");
  });

  it("counts only open/under-review flags", () => {
    expect(
      countOpenFlags([
        { status: "open" },
        { status: "under-review" },
        { status: "dismissed" },
        { status: "attested" },
        { status: "expired" },
      ]),
    ).toBe(2);
  });
});
