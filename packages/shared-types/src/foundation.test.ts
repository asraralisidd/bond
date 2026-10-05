import { describe, expect, it } from "vitest";
import { DomainError, isDomainError } from "./errors.js";
import {
  parseAgentId,
  parseBondId,
  parseOperatorId,
  parseProtocolEventId,
  parseTransactionId,
} from "./ids.js";
import { assertNeverEvent, createProtocolEvent } from "./events.js";
import { emptyLogMetadata, toLogMetadata } from "./observability.js";

describe("identifiers", () => {
  it("parses valid IDs and rejects empty, non-string, and oversized values", () => {
    expect(parseAgentId("agent-001")).toBe("agent-001");
    for (const bad of ["", 42, null, undefined, {}, "x".repeat(129)]) {
      try {
        parseAgentId(bad);
        expect.unreachable();
      } catch (error) {
        expect(isDomainError(error)).toBe(true);
        expect((error as DomainError).code).toBe("INVALID_IDENTIFIER");
      }
    }
    // Non-Error values are not domain errors.
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError("INVALID_IDENTIFIER")).toBe(false);
  });

  it("keeps domain ID families distinct at the type level", () => {
    const agentId = parseAgentId("id-1");
    const bondId = parseBondId("id-1");
    // Same runtime string, different brands: assignability is checked by
    // the compiler (the @ts-expect-error line below must stay an error).
    expect(agentId).toBe(bondId);
    function acceptsBondId(_id: ReturnType<typeof parseBondId>): void {}
    // @ts-expect-error - AgentId is not assignable to BondId
    acceptsBondId(agentId);
  });
});

describe("domain errors", () => {
  it("carries code, message, and structured details", () => {
    const error = new DomainError("INVALID_BOND_TRANSITION", "nope", {
      from: "CREATED",
      to: "ACTIVE",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.code).toBe("INVALID_BOND_TRANSITION");
    expect(error.details).toEqual({ from: "CREATED", to: "ACTIVE" });
  });
});

describe("protocol events", () => {
  it("creates typed, serializable events", () => {
    const event = createProtocolEvent({
      protocolEventId: parseProtocolEventId("evt-001"),
      type: "AGENT_REGISTERED",
      requestId: "req-001",
      agentId: parseAgentId("agent-001"),
      actor: "operator:test",
      policyVersion: null,
      occurredAt: "2026-10-06T00:00:00.000Z",
      payload: {
        operatorId: parseOperatorId("op-001"),
        status: "REGISTERED",
      },
    });
    expect(event.type).toBe("AGENT_REGISTERED");
    expect(event.eventVersion).toBe("v0");
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);

    const slash = createProtocolEvent({
      protocolEventId: parseProtocolEventId("evt-002"),
      type: "TRANSACTION_STATUS_CHANGED",
      actor: "system",
      occurredAt: "2026-10-06T00:00:00.000Z",
      payload: {
        transactionId: parseTransactionId("tx-001"),
        from: "PENDING",
        to: "SUBMITTED",
      },
    });
    expect(slash.payload.to).toBe("SUBMITTED");
    expect(() => assertNeverEvent("x" as never)).toThrow();
  });
});

describe("observability metadata", () => {
  it("carries correlation IDs only — no slot for private content", () => {
    expect(emptyLogMetadata()).toEqual({
      requestId: null,
      agentId: null,
      riskFlagId: null,
      attestationId: null,
      transactionId: null,
    });
    const meta = toLogMetadata({
      requestId: "req-001",
      agentId: parseAgentId("agent-001"),
    });
    expect(meta.requestId).toBe("req-001");
    expect(meta.agentId).toBe("agent-001");
    expect(Object.keys(meta).sort()).toEqual(
      [
        "agentId",
        "attestationId",
        "requestId",
        "riskFlagId",
        "transactionId",
      ].sort(),
    );
  });
});
