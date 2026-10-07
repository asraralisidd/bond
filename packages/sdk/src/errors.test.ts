/**
 * BondApiError + friendlyMessage + parseRetryAfter unit tests.
 * No network, no randomness — pure functions only.
 */
import { describe, expect, it } from "vitest";
import { BondApiError, friendlyMessage, parseRetryAfter } from "./errors.js";

describe("BondApiError", () => {
  it("carries code, message, status, requestId, and retryAfter", () => {
    const err = new BondApiError("NOT_FOUND", "Agent not found", 404, "req-9");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BondApiError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req-9");
    expect(err.retryAfter).toBeNull();
    const limited = new BondApiError("RATE_LIMITED", "slow", 429, "r1", 30);
    expect(limited.retryAfter).toBe(30);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and rejects anything else", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("  5  ")).toBe(5);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("1.5")).toBeNull();
    expect(parseRetryAfter("-3")).toBeNull();
  });
});

describe("friendlyMessage", () => {
  it("maps rate limiting to a calm message", () => {
    expect(
      friendlyMessage(new BondApiError("RATE_LIMITED", "x", 429, "r1")),
    ).toBe("Too many requests — please wait a moment and try again.");
  });

  it("prefixes other API errors with their code", () => {
    expect(
      friendlyMessage(new BondApiError("NOT_FOUND", "gone", 404, null)),
    ).toBe("NOT_FOUND: gone");
  });

  it("passes through non-API errors", () => {
    expect(friendlyMessage(new Error("boom"))).toBe("boom");
    expect(friendlyMessage("plain")).toBe("plain");
  });
});
