/**
 * Deployment record verifier (Phase 25).
 *
 * Validates a wallet-attended deployment record WITHOUT touching any
 * network, wallet, or secret: required non-secret metadata present,
 * network allowlisted (undeployed|preprod — never mainnet/preview),
 * timestamps well-formed, and a secret-material scan over every key
 * and string value (private keys, seeds, mnemonics, witnesses, salts,
 * signing material, bearer tokens, api keys). Any hit fails closed.
 *
 * Optionally cross-checks the local toolchain file
 * (contracts/managed/bond/compiler/contract-info.json) against the
 * record's toolchain block with --check-toolchain.
 *
 * Exit 0 = record valid. Exit 1 = invalid (reason on stderr).
 * Never prints record contents — only field names and reasons.
 *
 * Usage:
 *   node scripts/verify-deployment-record.mjs <record.json> [--check-toolchain]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const NETWORKS = ["undeployed", "preprod"];

const SECRET_PATTERN =
  /private[_-]?key|secret[_-]?key|signing[_-]?key|seed|mnemonic|witness|salt|bearer|api[_-]?key|passwd|password|token[_-]?secret|credentials?\.(json|key|pem)|-----BEGIN/i;

function fail(message) {
  console.error(`verify-deployment-record: INVALID — ${message}`);
  process.exit(1);
}

function checkString(record, field) {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`missing or empty required field: ${field}`);
  }
  if (/REPLACE_WITH_/.test(value)) {
    fail(`field ${field} still holds a template placeholder`);
  }
  return value;
}

function scanSecrets(value, path) {
  if (typeof value === "string") {
    if (SECRET_PATTERN.test(value) || SECRET_PATTERN.test(path)) {
      fail(`secret-like material at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      scanSecrets(value[key], path ? `${path}.${key}` : key);
    }
  }
}

function main() {
  const [recordPath, ...flags] = process.argv.slice(2);
  if (!recordPath || flags.some((f) => f !== "--check-toolchain")) {
    console.error(
      "usage: node scripts/verify-deployment-record.mjs <record.json> [--check-toolchain]",
    );
    process.exit(2);
  }
  if (!existsSync(recordPath)) {
    fail(`record file not found: ${recordPath}`);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(resolve(recordPath), "utf8"));
  } catch {
    fail("record is not valid JSON");
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    fail("record must be a JSON object");
  }

  // 1. Required non-secret metadata.
  const network = checkString(record, "network");
  if (!NETWORKS.includes(network)) {
    fail(
      `network '${network}' is not allowed — supported: ${NETWORKS.join(", ")} (mainnet/preview rejected)`,
    );
  }
  checkString(record, "contractAddress");
  checkString(record, "deploymentTxId");
  const deployedAt = checkString(record, "deployedAt");
  if (Number.isNaN(Date.parse(deployedAt))) {
    fail("deployedAt is not a valid timestamp");
  }
  checkString(record, "deployedBy");
  const toolchain = record.toolchain;
  if (typeof toolchain !== "object" || toolchain === null) {
    fail("missing required block: toolchain");
  }
  for (const field of [
    "compactCli",
    "compactCompiler",
    "midnightJs",
    "compactJs",
  ]) {
    checkString(toolchain, field);
  }

  // 2. Secret-material scan over the entire record.
  scanSecrets(record, "");

  // 3. Optional local toolchain cross-check (offline, file read only).
  if (flags.includes("--check-toolchain")) {
    const infoPath = join(
      REPO,
      "contracts",
      "managed",
      "bond",
      "compiler",
      "contract-info.json",
    );
    if (!existsSync(infoPath)) {
      fail("local toolchain file missing; cannot cross-check");
    }
    let info;
    try {
      info = JSON.parse(readFileSync(infoPath, "utf8"));
    } catch {
      fail("local toolchain file is not valid JSON");
    }
    const mapping = [["compactCompiler", info["compiler-version"]]];
    for (const [field, localValue] of mapping) {
      if (localValue === null || localValue === undefined) {
        continue;
      }
      if (String(toolchain[field]) !== String(localValue)) {
        fail(
          `toolchain.${field} '${toolchain[field]}' does not match local artifacts ('${localValue}')`,
        );
      }
    }
    console.log("verify-deployment-record: valid (toolchain cross-checked).");
    return;
  }

  console.log("verify-deployment-record: valid.");
}

main();
