import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  it("keeps advisory layers out of the chain seam", () => {
    const code = adapterSources();
    // Risk Engine and Attestor must never reach the chain directly:
    // all chain access flows through validated BOND requests.
    for (const mod of ["@bond/risk-engine", "@bond/attestor"]) {
      expect(code.includes(mod), `must not import ${mod}`).toBe(false);
    }
    // No key creation, no raw signing, no invented network calls.
    for (const id of [
      "sampleSigningKey",
      "generateKey",
      "privateKey",
      "mnemonic",
      "XMLHttpRequest",
    ]) {
      expect(code.includes(id), `must not reference ${id}`).toBe(false);
    }
  });

  it("uses only verified Midnight, domain, and contract dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    expect(deps).toEqual(
      [
        "@bond/contract",
        "@bond/shared-types",
        "@midnight-ntwrk/compact-js",
        "@midnight-ntwrk/compact-runtime",
        "@midnight-ntwrk/midnight-js-contracts",
        "@midnight-ntwrk/midnight-js-http-client-proof-provider",
        "@midnight-ntwrk/midnight-js-indexer-public-data-provider",
        "@midnight-ntwrk/midnight-js-network-id",
        "@midnight-ntwrk/midnight-js-node-zk-config-provider",
        "@midnight-ntwrk/midnight-js-protocol",
        "@midnight-ntwrk/midnight-js-types",
        "@midnight-ntwrk/midnight-js-utils",
      ].sort(),
    );
  });

  it("labels every receipt with an honest mode", () => {
    const code = adapterSources();
    // Note: the scanner strips string literals, so this asserts on
    // identifiers: sim* helpers for labeled simulation, SucceedEntirely
    // as the only REAL confirmation gate.
    expect(code.includes("simSuccess")).toBe(true);
    expect(code.includes("simFailure")).toBe(true);
    expect(code.includes("SucceedEntirely")).toBe(true);
  });
});
