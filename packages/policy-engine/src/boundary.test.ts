import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePolicy } from "./evaluate.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function policySources(): Array<{ file: string; content: string }> {
  return readdirSync(HERE)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({
      file,
      content: readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"([^"\\]|\\.)*"/g, '""')
        .replace(/'([^'\\]|\\.)*'/g, "''")
        .replace(/`([^`\\]|\\.)*`/g, "``"),
    }));
}

describe("security boundary (architectural)", () => {
  it("imports only the shared domain package — no chain surface exists", () => {
    const forbiddenModules = [
      "@bond/attestor",
      "@bond/midnight-adapter",
      "@bond/risk-engine",
      "pg",
    ];
    const forbiddenIdentifiers = [
      "wallet",
      "Wallet",
      "signTransaction",
      "submitTransaction",
      "SlashEvent",
      "Attestation",
      "TransactionRecord",
      "transitionBond",
      "createSlashEvent",
      "slash",
      "Slash",
      "withdraw",
      "Withdraw",
      "process.env",
      "Date.now",
      "Math.random",
      "fetch",
    ];
    for (const { file, content } of policySources()) {
      for (const mod of forbiddenModules) {
        expect(content.includes(mod), `${file} must not import ${mod}`).toBe(
          false,
        );
      }
      for (const id of forbiddenIdentifiers) {
        expect(content.includes(id), `${file} must not reference ${id}`).toBe(
          false,
        );
      }
    }
  });

  it("declares no blockchain, wallet, chain, or ML dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(["@bond/shared-types"]);
  });

  it("emits decisions only — output has no enforcement surface", () => {
    const result = evaluatePolicy({
      activity: {
        provider: "acme",
        model: "acme-small",
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        costMinorUnits: "5",
      },
      policy: null,
      usage: { requestCount: 0, totalTokens: "0", totalCostMinorUnits: "0" },
      policyVersion: "bond-policy-v1",
    });
    expect(Object.keys(result).sort()).toEqual(
      ["allowed", "policyVersion", "violations"].sort(),
    );
    const serialized = JSON.stringify(result);
    for (const token of [
      "slash",
      "Slash",
      "withdraw",
      "Withdraw",
      "wallet",
      "Wallet",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
  });
});
