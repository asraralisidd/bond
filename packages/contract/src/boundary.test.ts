import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function contractSources(): string {
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

describe("contract security boundary (architectural)", () => {
  it("imports no risk, attestor, wallet, or chain implementation", () => {
    const code = contractSources();
    for (const mod of [
      "@bond/risk-engine",
      "@bond/attestor",
      "@bond/midnight-adapter",
    ]) {
      expect(code.includes(mod), `must not import ${mod}`).toBe(false);
    }
    for (const id of [
      "RiskFlag",
      "analyzeActivity",
      "evaluateQuorum",
      "decide(",
      "wallet",
      "Wallet",
      "privateKey",
      "signTransaction",
      "submitTransaction",
      "midnight",
      "Midnight",
      "fetch(",
      "pgClient",
      "postgres",
    ]) {
      expect(code.includes(id), `must not reference ${id}`).toBe(false);
    }
  });

  it("declares only the shared domain dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@bond/shared-types"]);
  });
});
