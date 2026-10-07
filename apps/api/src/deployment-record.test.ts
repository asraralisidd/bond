/**
 * Deployment-record verifier tests (Phase 25).
 *
 * Spawns `scripts/verify-deployment-record.mjs` as a child process
 * with record fixtures written to the OS temp dir (never the repo)
 * and asserts exit codes + output. No network, no wallet, no chain
 * contact of any kind.
 *
 * Proves: template placeholders rejected, mainnet/preview
 * rejected, secret-like material rejected anywhere in the record,
 * malformed records rejected, valid records accepted, and the
 * local toolchain cross-check passes against real artifacts.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "verify-deployment-record.mjs");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 30000 },
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

function writeRecord(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bond-deployment-record-"));
  const path = join(dir, "record.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function validRecord(): Record<string, unknown> {
  return {
    network: "preprod",
    contractAddress: "mn_test_deployment_record",
    deploymentTxId: "tx-test-1",
    deployedAt: "2026-10-07T00:00:00.000Z",
    deployedBy: "op-test",
    toolchain: {
      compactCli: "0.5.3",
      compactCompiler: "0.31.1",
      midnightJs: "4.1.1",
      compactJs: "2.5.1",
    },
    artifactIdentity: "git-test",
    proofServer: "proof-server:8.1.0",
    funding: "preprod test funds",
  };
}

describe("verify-deployment-record script", () => {
  it("rejects usage errors and missing files", async () => {
    const usage = await runScript([]);
    expect(usage.code).toBe(2);
    const missing = await runScript(["/does/not/exist.json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not found/);
  });

  it("rejects the unfilled template", async () => {
    const result = await runScript([
      join(REPO, "docs", "phase-25", "deployment-record.TEMPLATE.json"),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/placeholder/);
  });

  it("rejects mainnet, preview, and malformed records", async () => {
    for (const network of ["mainnet", "preview", ""]) {
      const result = await runScript([
        writeRecord({ ...validRecord(), network }),
      ]);
      expect(result.code, network).toBe(1);
    }
    const mainnet = await runScript([
      writeRecord({ ...validRecord(), network: "mainnet" }),
    ]);
    expect(mainnet.stderr).toMatch(/not allowed/);
    const badDate = await runScript([
      writeRecord({ ...validRecord(), deployedAt: "yesterday" }),
    ]);
    expect(badDate.code).toBe(1);
    const badJson = await runScript([writeRecord("not-an-object")]);
    expect(badJson.code).toBe(1);
  });

  it("rejects secret-like material anywhere in the record", async () => {
    for (const poison of [
      { private_key: "deadbeef" },
      { notes: "mnemonic words follow" },
      { nested: { witness: "abc123" } },
      { funding: "api_key=sk-live" },
    ]) {
      const result = await runScript([
        writeRecord({ ...validRecord(), ...poison }),
      ]);
      expect(result.code, JSON.stringify(poison)).toBe(1);
      expect(result.stderr).toMatch(/secret-like material/);
    }
  });

  it("accepts a valid record and cross-checks the toolchain", async () => {
    const result = await runScript([writeRecord(validRecord())]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/valid/);
    const checked = await runScript([
      writeRecord(validRecord()),
      "--check-toolchain",
    ]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toMatch(/cross-checked/);
    const drifted = await runScript([
      writeRecord({
        ...validRecord(),
        toolchain: {
          ...(validRecord().toolchain as Record<string, string>),
          compactCompiler: "0.0.0",
        },
      }),
      "--check-toolchain",
    ]);
    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toMatch(/does not match/);
  });

  it("never echoes record contents", async () => {
    const marker = "mn_test_deployment_record";
    const result = await runScript([writeRecord(validRecord())]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).not.toContain(marker);
  });
});
