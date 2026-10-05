import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./decision.js";
import {
  EXPIRES_AT,
  FULL_EVIDENCE,
  NOW,
  REQUESTED_AT,
  makeFlag,
  standardProfile,
} from "./fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function attestorSources(): string {
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

describe("security boundary (architectural)", () => {
  it("has no wallet, chain, midnight, slash, or bond-mutation surface", () => {
    const code = attestorSources();
    for (const mod of ["@bond/midnight-adapter", "@bond/risk-engine"]) {
      expect(code.includes(mod), `must not import ${mod}`).toBe(false);
    }
    for (const id of [
      "wallet",
      "Wallet",
      "privateKey",
      "createSlashEvent",
      "completeSlashEvent",
      "transitionBond",
      "submitTransaction",
      "signTransaction",
      "midnight",
      "Midnight",
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

  it("emits decisions only — output has no enforcement capability", () => {
    const outcome = decide({
      attestationId: "att-201",
      flag: makeFlag({ flagId: "flag-201" }),
      availableEvidenceIds: FULL_EVIDENCE,
      profiles: [
        standardProfile("attestor-a", "Org A"),
        standardProfile("attestor-b", "Org B"),
      ],
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      policyVersion: "policy v3",
      nowIso: NOW,
    });
    expect(Object.keys(outcome).sort()).toEqual(
      [
        "attestation",
        "evaluations",
        "ineligibleAttestors",
        "nullifier",
        "recommendedAction",
        "status",
        "systemVersion",
      ].sort(),
    );
    const serialized = JSON.stringify(outcome);
    for (const token of [
      "wallet",
      "Wallet",
      "privateKey",
      "submitTransaction",
      "transitionBond",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
    // No SlashEvent is produced: statuses are decision lifecycle only.
    expect(outcome.attestation.status).toBe("decided");
  });
});
