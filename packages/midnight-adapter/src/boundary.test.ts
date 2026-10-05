import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMidnight } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function adapterSources(): string {
  return readdirSync(HERE)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) =>
      readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"([^"\\]|\\.)*"/g, '""')
        .replace(/'([^'\\]|\\.)*'/g, "''")
        .replace(/`([^`\\]|\\.)*`/g, "``"),
    )
    .join("\n");
}

describe("adapter boundary (architectural)", () => {
  it("contains no chain, wallet, signing, or network behavior", () => {
    const code = adapterSources();
    for (const id of [
      "wallet",
      "Wallet",
      "signTransaction",
      "submitTransaction",
      "privateKey",
      "fetch(",
      "WebSocket",
      "midnight-js",
    ]) {
      expect(code.includes(id), `must not reference ${id}`).toBe(false);
    }
    // No invented generated-module surface.
    expect(code.includes("generated")).toBe(false);
  });

  it("declares only domain and contract dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(
      ["@bond/contract", "@bond/shared-types"].sort(),
    );
  });

  it("never fakes a chain connection", () => {
    expect(() => connectMidnight()).toThrowError(
      /Phase 5|compiled contract artifacts/,
    );
  });
});
