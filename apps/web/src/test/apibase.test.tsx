/**
 * API-base resolution tests (Phase 15): production builds require an
 * explicit VITE_API_URL; development keeps the localhost default.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveApiBase } from "../api/client.js";

describe("resolveApiBase", () => {
  it("prefers an explicitly configured URL in any mode", () => {
    expect(resolveApiBase("https://api.example.com", false)).toBe(
      "https://api.example.com",
    );
    expect(resolveApiBase("https://api.example.com", true)).toBe(
      "https://api.example.com",
    );
  });

  it("falls back to localhost in development only", () => {
    expect(resolveApiBase(undefined, false)).toBe("http://localhost:4000");
    expect(resolveApiBase("", false)).toBe("http://localhost:4000");
  });

  it("fails clearly in production without VITE_API_URL", () => {
    expect(() => resolveApiBase(undefined, true)).toThrowError(
      /VITE_API_URL must be set/,
    );
    expect(() => resolveApiBase("", true)).toThrowError(
      /refusing the localhost default/,
    );
  });

  it("production Dockerfile cannot build an image without VITE_API_URL", () => {
    // Structural prevention: the image build itself refuses an empty
    // arg, so no producible production bundle can silently target
    // localhost. (Verified live via `docker build` with/without the
    // arg; this pins the guard against regression.)
    const dockerfile = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "..",
        "apps",
        "web",
        "Dockerfile",
      ),
      "utf8",
    );
    expect(dockerfile).toMatch(/ARG VITE_API_URL/);
    expect(dockerfile).toMatch(/VITE_API_URL build-arg is required/);
    expect(dockerfile).toMatch(/exit 1/);
  });
});
