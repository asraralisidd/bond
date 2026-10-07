/**
 * Metadata redaction unit tests. Asserts parity with the backend
 * secret-like key policy: matching keys dropped (names only), values
 * never retained, primitives truncated, non-primitives dropped.
 */
import { describe, expect, it } from "vitest";
import { isSecretLikeKey, redactMetadata, truncateSnippet } from "./redact.js";

describe("isSecretLikeKey", () => {
  it("flags secret-like keys and passes ordinary ones", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "api-key",
      "secret",
      "clientSecret",
      "password",
      "passwd",
      "token",
      "accessToken",
      "privateKey",
      "private_key",
      "seed",
      "mnemonic",
      "auth",
      "authorization",
      "credential",
      "bearer",
      "X-Attestor-Secret",
    ]) {
      expect(isSecretLikeKey(key)).toBe(true);
    }
    for (const key of ["tool", "action", "model", "temperature", "count"]) {
      expect(isSecretLikeKey(key)).toBe(false);
    }
  });
});

describe("redactMetadata", () => {
  it("drops secret-like keys without retaining values", () => {
    const { metadata, redactedFields } = redactMetadata({
      model: "x",
      apiKey: "sk-live-secret",
      count: 3,
    });
    expect(metadata).toEqual({ count: 3, model: "x" });
    expect(redactedFields).toContain("apiKey");
    expect(JSON.stringify({ metadata, redactedFields })).not.toContain(
      "sk-live-secret",
    );
  });

  it("drops non-primitive values and truncates long strings", () => {
    const { metadata, redactedFields } = redactMetadata({
      nested: { deep: true },
      list: [1, 2],
      long: "y".repeat(300),
    });
    expect(metadata.long).toBe("y".repeat(256));
    expect(redactedFields).toContain("nested");
    expect(redactedFields).toContain("list");
  });

  it("handles undefined and sorts keys deterministically", () => {
    expect(redactMetadata(undefined)).toEqual({
      metadata: {},
      redactedFields: [],
    });
    const first = redactMetadata({ b: 1, a: 2 });
    const second = redactMetadata({ a: 2, b: 1 });
    expect(first).toEqual(second);
  });
});

describe("truncateSnippet", () => {
  it("caps free text at the server budget", () => {
    expect(truncateSnippet(undefined)).toBeNull();
    expect(truncateSnippet("short")).toBe("short");
    expect(truncateSnippet("z".repeat(600))).toBe("z".repeat(500));
  });
});
