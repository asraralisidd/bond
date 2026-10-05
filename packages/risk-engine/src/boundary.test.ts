import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeActivity } from "./engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function engineSources(): Array<{ file: string; content: string }> {
  return readdirSync(HERE)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({
      file,
      // Strip comments and string literals: the boundary applies to code,
      // while doc comments legitimately NAME the forbidden concepts.
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
    const forbiddenModules = ["@bond/attestor", "@bond/midnight-adapter"];
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
    ];
    for (const { file, content } of engineSources()) {
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

  it("emits risk information only — output has no enforcement surface", () => {
    const result = analyzeActivity({
      activityId: "act-boundary",
      agentId: "agent-001",
      occurredAt: "2026-10-01T12:00:00.000Z",
      actionType: "transfer",
      action: "pay-vendor",
      amountMinorUnits: "999999",
      policyContext: {
        policyVersion: "policy v3",
        spendLimitMinorUnits: "100",
      },
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "analysisId",
        "agentId",
        "engineVersion",
        "evidence",
        "findings",
        "flags",
        "logMetadata",
        "ruleSetVersion",
        "scoringVersion",
        "score",
        "skippedDuplicateKeys",
      ].sort(),
    );
    const serialized = JSON.stringify(result);
    // Note: "transaction-record" is a legitimate Phase 0 evidence category
    // and IS expected in evidence refs; enforcement tokens are not.
    for (const token of [
      "slash",
      "Slash",
      "withdraw",
      "Withdraw",
      "wallet",
      "Wallet",
      "submitTransaction",
      "signTransaction",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
  });

  it("never retains input secrets in any output", () => {
    const result = analyzeActivity({
      activityId: "act-secrets",
      agentId: "agent-001",
      occurredAt: "2026-10-01T12:00:00.000Z",
      actionType: "tool-call",
      action: "read-file",
      metadata: {
        api_key: "sk-CANARY-SECRET-001",
        password: "CANARY-PASSWORD-002",
      },
      policyContext: {
        policyVersion: "policy v3",
        allowedActions: ["read-file"],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-CANARY-SECRET-001");
    expect(serialized).not.toContain("CANARY-PASSWORD-002");
  });
});
