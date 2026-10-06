/**
 * Compiles contracts/bond.compact with the verified Midnight Compact
 * toolchain and emits managed bindings to contracts/managed/bond.
 *
 * Binary discovery: $COMPACT_BIN, ~/.local/bin/compact,
 * ~/.compact/bin/compact, then PATH `compact` — each probed with
 * `compile --version` (Midnight prints semver; other `compact`
 * namesakes do not). Fails loudly when no compiler is found.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const source = join(root, "contracts", "bond.compact");
const target = join(root, "contracts", "managed", "bond");

const candidates = [
  process.env.COMPACT_BIN,
  join(homedir(), ".local", "bin", "compact"),
  join(homedir(), ".compact", "bin", "compact"),
  "compact",
].filter(Boolean);

function looksLikeMidnightCompact(bin) {
  const probe = spawnSync(bin, ["compile", "--version"], {
    encoding: "utf8",
    shell: false,
  });
  if (probe.error || probe.status !== 0) {
    return false;
  }
  const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  return /^\d+\.\d+\.\d+/.test(text);
}

const bin = candidates.find((candidate) => {
  if (candidate !== "compact" && !existsSync(candidate)) {
    return false;
  }
  return looksLikeMidnightCompact(candidate);
});

if (bin === undefined) {
  console.error(
    "Midnight Compact compiler not found. Install the Compact CLI " +
      "(verified: compact 0.5.3 / compiler 0.31.1) or set COMPACT_BIN.",
  );
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`Missing Compact source at ${source}`);
  process.exit(1);
}

const result = spawnSync(bin, ["compile", source, target], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
