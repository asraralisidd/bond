/**
 * Deploy-script behavior tests (Phase 14 blocker fix).
 *
 * Spawns `scripts/deploy-contract.mjs` as a child process with hermetic
 * env and asserts exit codes + output. Requires the built adapter dist
 * (the script imports it); skips cleanly when dist is absent instead of
 * failing — run `npm run build` first for full coverage.
 *
 * Proves: no-network/mainnet/SIMULATED refusal, dry-run plan without
 * submission, replace-guard, and --live reporting wallet-attended
 * BLOCKED via the real deployBondContract seam (never a fake success,
 * never a fabricated address).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "deploy-contract.mjs");
const DIST = join(REPO, "packages", "midnight-adapter", "dist", "index.js");

const HAS_DIST = existsSync(DIST);

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        clean[key] = value;
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete clean[key];
      } else {
        clean[key] = value;
      }
    }
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: clean, timeout: 30000 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

describe.skipIf(!HAS_DIST)("deploy-contract script", () => {
  it("refuses without an explicit network", async () => {
    const result = await runScript([], { MIDNIGHT_NETWORK: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/BLOCKED/);
    expect(result.stderr).toMatch(/MIDNIGHT_NETWORK is not set/);
  });

  it("rejects mainnet and unknown networks", async () => {
    const mainnet = await runScript([], { MIDNIGHT_NETWORK: "mainnet" });
    expect(mainnet.code).toBe(1);
    expect(mainnet.stderr).toMatch(/not enabled/);
    const unknown = await runScript([], { MIDNIGHT_NETWORK: "nope" });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown MIDNIGHT_NETWORK/);
  });

  it("refuses SIMULATED configuration", async () => {
    const result = await runScript([], { MIDNIGHT_NETWORK: "simulated" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/requires REAL configuration/);
  });

  it("dry-run verifies the plan and submits nothing", async () => {
    const result = await runScript(["--dry-run"], {
      MIDNIGHT_NETWORK: "undeployed",
      BOND_CONTRACT_ADDRESS: undefined,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/12\/12 artifacts verified/);
    expect(result.stdout).toMatch(/No transaction submitted/);
    expect(result.stdout).not.toMatch(/contractAddress.*[0-9a-f]{4,}/i);
  });

  it("refuses to supersede an existing address without --replace", async () => {
    const result = await runScript([], {
      MIDNIGHT_NETWORK: "undeployed",
      BOND_CONTRACT_ADDRESS: "addr-existing",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/already set/);
    const replaced = await runScript(["--replace"], {
      MIDNIGHT_NETWORK: "undeployed",
      BOND_CONTRACT_ADDRESS: "addr-existing",
    });
    expect(replaced.code).toBe(0);
  });

  it("--live reports wallet-attended BLOCKED via the real seam", async () => {
    const result = await runScript(["--live"], {
      MIDNIGHT_NETWORK: "undeployed",
      BOND_CONTRACT_ADDRESS: undefined,
    });
    expect(result.code).toBe(1);
    // Names the exact seam and the exact missing wallet-attended pieces.
    expect(result.stderr).toMatch(/deployBondContract/);
    expect(result.stderr).toMatch(/WalletAndMidnightProvider/);
    expect(result.stderr).toMatch(/operatorSecret/);
    expect(result.stderr).toMatch(/Nothing was submitted/);
    // No fabricated address anywhere in output.
    expect(result.stdout).not.toMatch(/0x[0-9a-f]{8,}/i);
    expect(result.stderr).not.toMatch(/0x[0-9a-f]{8,}/i);
  });
});
