/**
 * BOND contract deployment prerequisites script (Phase 14).
 *
 * Validates everything that can be validated offline via the existing
 * verified adapter seam (`resolveMidnightConfig`, `connectMidnight`,
 * `deployBondContract`): configuration, network, artifacts, toolchain.
 * This script NEVER holds wallet keys, NEVER generates operator secrets,
 * and NEVER submits without an injected wallet provider.
 *
 * Actual deployment — `deployBondContract(handle, { initialPrivateState })`
 * — requires a wallet-attended provider context: a REAL handle built from
 * an injected `WalletAndMidnightProvider` (browser/Lace wallet) plus
 * operator-supplied private state containing the 32-byte operatorSecret.
 * A Node CLI fundamentally cannot supply either without inventing a fake
 * wallet or handling secrets, both of which are forbidden. The --live
 * path therefore verifies the seam, attempts handle construction, and
 * reports the exact missing prerequisites (BLOCKED) instead of
 * performing deployment. Deployment itself happens through the
 * operator wallet layer, never through this script.
 *
 * Modes:
 *   --dry-run (default): validate configuration, network, and artifacts;
 *                        print the deployment plan; submit nothing.
 *   --live:              verify the deployBondContract seam, attempt the
 *                        real handle construction, and report BLOCKED with
 *                        the exact missing wallet-attended prerequisites —
 *                        a fake success is structurally impossible.
 *
 * Requires `npm run build` first (imports the built adapter dist).
 * Requires MIDNIGHT_NETWORK to be set explicitly (undeployed|preprod).
 * Never defaults to mainnet; mainnet/preview are rejected by config.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ADAPTER_DIST = join(
  REPO,
  "packages",
  "midnight-adapter",
  "dist",
  "index.js",
);

const CIRCUITS = [
  "registerAgent",
  "lockBond",
  "activateAgent",
  "flagAgent",
  "resolveAgent",
  "reactivateAgent",
  "processEnforcement",
  "releaseBond",
  "withdrawBond",
  "proveEligibility",
  "revokeEligibility",
  "consumeEligibility",
];

function fail(message) {
  console.error(`deploy-contract: BLOCKED — ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    "usage: node scripts/deploy-contract.mjs [--dry-run|--live] [--replace]",
  );
  process.exit(2);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (!["--dry-run", "--live", "--replace"].includes(arg)) {
      usage();
    }
  }
  const live = args.has("--live");
  if (!existsSync(ADAPTER_DIST)) {
    fail(
      "adapter dist not built. Run `npm run build` first, then re-run this script.",
    );
  }
  const adapter = await import(ADAPTER_DIST);

  // 1. Explicit network selection — never defaulted, never mainnet.
  const rawNetwork = (process.env.MIDNIGHT_NETWORK ?? "").trim();
  if (!rawNetwork) {
    fail(
      "MIDNIGHT_NETWORK is not set. Set it explicitly to 'undeployed' or 'preprod'.",
    );
  }
  let config;
  try {
    config = adapter.resolveMidnightConfig(process.env);
  } catch (error) {
    fail(`invalid Midnight configuration: ${error.message ?? error}`);
  }
  if (config.mode !== "REAL" || config.endpoints === null) {
    fail(
      `deployment requires REAL configuration, resolved mode=${config.mode}. ` +
        "Refusing to deploy from SIMULATED/UNAVAILABLE configuration.",
    );
  }
  const { networkId, indexerHttp, indexerWs, nodeUrl, proofServerUrl } =
    config.endpoints;

  // 2. Artifact verification: all 12 circuits present with keys.
  const zkPath =
    process.env.BOND_ZK_ASSETS_PATH?.trim() ||
    join(REPO, "contracts", "managed", "bond");
  const missing = [];
  for (const circuit of CIRCUITS) {
    for (const ext of ["prover", "verifier", "zkir", "bzkir"]) {
      const file =
        ext === "prover" || ext === "verifier"
          ? join(zkPath, "keys", `${circuit}.${ext}`)
          : join(zkPath, "zkir", `${circuit}.${ext}`);
      if (!existsSync(file)) {
        missing.push(file);
      }
    }
  }
  if (!existsSync(join(zkPath, "contract", "index.js"))) {
    missing.push(join(zkPath, "contract", "index.js"));
  }
  if (missing.length > 0) {
    fail(`missing contract artifacts:\n  ${missing.join("\n  ")}`);
  }
  let toolchain = "unknown";
  try {
    const info = JSON.parse(
      readFileSync(join(zkPath, "compiler", "contract-info.json"), "utf8"),
    );
    toolchain = `compiler ${info["compiler-version"]}, language ${info["language-version"]}, runtime ${info["runtime-version"]}`;
  } catch {
    fail("cannot read compiler/contract-info.json; artifacts unverifiable.");
  }

  // 3. Existing deployment guard: never silently supersede an address.
  const existing = (process.env.BOND_CONTRACT_ADDRESS ?? "").trim();
  if (existing && !args.has("--replace")) {
    fail(
      `BOND_CONTRACT_ADDRESS is already set (${existing}). ` +
        "Pass --replace to acknowledge deploying a new contract instance.",
    );
  }

  console.log("BOND contract deployment plan (dry-run verification):");
  console.log(`  network:              ${networkId}`);
  console.log(`  indexer:              ${indexerHttp}`);
  console.log(`  indexer ws:           ${indexerWs}`);
  console.log(`  node:                 ${nodeUrl}`);
  console.log(`  proof server:         ${proofServerUrl}`);
  console.log(`  zk assets:            ${zkPath}`);
  console.log(`  toolchain:            ${toolchain}`);
  console.log(
    `  circuits:             ${CIRCUITS.length}/12 artifacts verified`,
  );
  console.log(
    `  initial private state:  NOT generated here — supplied by the operator wallet layer at submission time`,
  );

  if (!live) {
    console.log(
      "dry-run complete: configuration, network, and artifacts verified. " +
        "No transaction submitted. Re-run with --live once a funded wallet provider is available.",
    );
    return;
  }

  // 4. Live path: verify the deployBondContract seam exists with the
  // expected signature, then attempt the real handle construction.
  // deployBondContract(handle, { initialPrivateState }) requires a REAL
  // handle whose providers come from an injected WalletAndMidnightProvider
  // (browser/Lace wallet) plus operator-supplied private state holding the
  // 32-byte operatorSecret. A Node CLI can supply neither without inventing
  // a fake wallet or handling secrets — both forbidden — so connectMidnight
  // without an injected wallet throws MIDNIGHT_UNAVAILABLE by design. The
  // script reports the exact missing wallet-attended prerequisites and
  // exits non-zero. Submission without a wallet is impossible.
  if (typeof adapter.deployBondContract !== "function") {
    fail(
      "adapter seam changed: deployBondContract is not exported as a function. " +
        "Refusing to proceed against an unexpected seam.",
    );
  }
  if (adapter.deployBondContract.length < 2) {
    fail(
      "adapter seam changed: deployBondContract signature unexpected " +
        "(expected (handle, input)). Refusing to proceed.",
    );
  }
  try {
    adapter.connectMidnight(config);
  } catch (error) {
    fail(
      `wallet-attended deployment BLOCKED (${error.message ?? error}). ` +
        "deployBondContract requires: (1) a REAL handle built from an injected " +
        "WalletAndMidnightProvider — only a browser/Lace wallet can supply this, " +
        "never a Node CLI; (2) operator-supplied initialPrivateState containing " +
        "the 32-byte operatorSecret, which this script will never generate, accept, " +
        "or transmit. Also required: funded operator wallet and reachable " +
        "indexer/node/proof-server. Nothing was submitted; no address fabricated.",
    );
  }
  fail(
    "unexpected: wallet provider present but live submission is intentionally " +
      "not automated by this script. Perform submission through the wallet-attended flow.",
  );
}

await main();
