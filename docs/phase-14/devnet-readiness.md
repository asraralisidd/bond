# Phase 14 — Devnet Readiness & REAL E2E Preparation

**LIVE NETWORK EXECUTION: BLOCKED / NOT VERIFIED.**

No funded wallet, deployed contract, or verified reachable live
environment exists in this environment. Nothing below fabricates live
execution. Every claim is labeled.

## Status labels

- **VERIFIED LOCALLY** — deterministic tests pass with no external infra.
- **INTEGRATION-READY** — wired against verified installed APIs; needs
  external prerequisites to exercise.
- **LIVE-NETWORK VERIFIED** — exercised against a real Midnight network.
  (None in this phase.)
- **BLOCKED / NOT VERIFIED** — explicitly deferred or impossible here.

## What was implemented (Phase 14)

1. **Env-gated live E2E harness — VERIFIED LOCALLY.**
   `apps/api/src/services/live-e2e.ts` + `live-midnight.live.test.ts`
   (skipped without `BOND_E2E_LIVE=1`) + `live-harness.test.ts`
   (offline, default suite) + `npm run test:live`. The gate fails
   loudly on missing REAL config or contract address; it never falls
   back to SIMULATED.
2. **Deployment script — VERIFIED LOCALLY** (dry-run + fail paths).
   `scripts/deploy-contract.mjs` uses only the verified
   `resolveMidnightConfig`/`connectMidnight`/`deployBondContract` seam:
   validates explicit network (never mainnet — rejected), all 12
   circuits' artifacts, toolchain versions, the replace-guard for an
   existing address, and the `deployBondContract(handle, input)`
   signature. `--dry-run` submits nothing; `--live` verifies the seam
   then exits non-zero reporting wallet-attended BLOCKED (a Node CLI
   cannot supply the injected wallet provider or operator private
   state). The script validates prerequisites; it never deploys.
3. **`/ready` contract reachability — VERIFIED LOCALLY.**
   `checks.midnight.contract` reports `not-applicable` /
   `address-missing` / `unreachable` / `reachable` / `misconfigured`
   via read-only `findBondContract` (no submission, no wallet state,
   5s bound, no secret/URL/path leakage). Overall readiness semantics
   unchanged.
4. **Compose Midnight passthrough — VERIFIED LOCALLY** (config parse).
   `docker-compose.yml` forwards `MIDNIGHT_*`, `BOND_CONTRACT_ADDRESS`,
   `BOND_ZK_ASSETS_PATH` with empty SIMULATED-preserving defaults.
5. **Prod fail-closed contract address — VERIFIED LOCALLY.** Production
   - REAL network without `BOND_CONTRACT_ADDRESS` fails startup.

## Prerequisites (all BLOCKED until provisioned)

| Requirement                                       | Status       | Notes                                                             |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| Funded operator wallet (Lace/compatible)          | BLOCKED      | browser-injected only; backend never holds keys                   |
| Deployed BOND contract + `BOND_CONTRACT_ADDRESS`  | BLOCKED      | see deployment procedure below (script validates, wallet deploys) |
| Reachable indexer/node/proof-server               | NOT VERIFIED | preprod endpoints respond to probes; submission/proving untested  |
| Deployed-contract E2E (submit→finality→reconcile) | BLOCKED      | harness + sweeps ready; needs the three rows above                |
| `preview`/`mainnet`                               | BLOCKED      | rejected without verified presets (unchanged)                     |

## Environment variables

| Variable                                                             | Required when                 | Notes                                                                                     |
| -------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `MIDNIGHT_NETWORK`                                                   | always explicit in production | `undeployed`\|`preprod`→REAL; `simulated`\|empty→SIMULATED; `mainnet`\|`preview` rejected |
| `BOND_CONTRACT_ADDRESS`                                              | production + REAL             | startup fails without it (Phase 14)                                                       |
| `BOND_ZK_ASSETS_PATH`                                                | optional                      | defaults to `contracts/managed/bond`                                                      |
| `MIDNIGHT_INDEXER_HTTP/_WS`, `MIDNIGHT_NODE_URL`, `PROOF_SERVER_URL` | REAL                          | preset defaults per network; override as needed                                           |
| `BOND_E2E_LIVE=1`                                                    | live tests only               | without it, live tests skip; never required for CI                                        |
| `DEV_AUTH_TOKEN`                                                     | dev only                      | forbidden in production (unchanged)                                                       |

## Deployment procedure

1. `npm run build` (adapter dist required by the deploy script).
2. Set `MIDNIGHT_NETWORK=undeployed` (local devnet) or `preprod`.
3. `node scripts/deploy-contract.mjs --dry-run` — verify 12/12
   artifacts, toolchain, endpoints.
4. `node scripts/deploy-contract.mjs --live` — verifies the
   `deployBondContract` seam exists, then reports BLOCKED with the exact
   missing wallet-attended prerequisites. The script itself never
   performs deployment: actual deployment is a wallet-attended operation
   — the operator wallet layer calls `deployBondContract(handle,
{ initialPrivateState })` with an injected `WalletAndMidnightProvider`
   and operator-supplied private state (32-byte operatorSecret), which a
   Node CLI cannot supply without inventing a fake wallet or handling
   secrets (both forbidden).
5. After wallet-attended deployment, record the returned contract
   address in `BOND_CONTRACT_ADDRESS`.
6. Confirm `/ready` reports
   `checks.midnight.contract.status === "reachable"`.
7. Run `npm run test:live` for read-only contract verification.

**Post-deployment verification:** `/ready` reachable status +
`test:live` green + first wallet-relayed submission observed through
`POST /transactions/:id/submitted` → worker reconciliation →
CONFIRMED on `SucceedEntirely` finality.

**Failure modes:** missing wallet → `MIDNIGHT_UNAVAILABLE` (exit 1,
nothing submitted); unreachable endpoints → `unreachable` status,
retried next pass; conflicting chain refs → 409; unknown network →
startup throw; existing address without `--replace` → refusal.

## Tests added

- `live-harness.test.ts` (10, default suite): gate parsing, loud
  failures, no-SIM-fallback, contract-address requirement, arg
  determinism, malformed-amount rejection, read-only assembly guards.
- `live-midnight.live.test.ts` (2 offline gate tests always run; 3 live
  tests skip without the gate): REAL resolution, read-only provider
  assembly + `findBondContract`, eligibility arg construction.
- `production.test.ts` (+6): `/ready` contract states
  (not-applicable/address-missing/unreachable/misconfigured, no-leak
  assertion) + prod contract-address rule + SIMULATED-without-address.
- Existing CORS/dev-auth fixtures switched to `simulated` (intent
  preserved; they are not contract tests).

## Security review

- No secrets in script output (endpoints are public URLs; no keys
  exist to leak); `/ready` exposes status enums only (test asserts no
  address/URL leakage); deploy script generates no secrets and stores
  nothing.
- No mainnet enablement path (config rejects; script validates).
- No REAL→SIMULATED fallback anywhere new (harness throws; deploy
  refuses non-REAL; `/ready` reports truthfully).
- No duplicate submission (unchanged idempotency + chain-ref resume).
- No fabricated finality (untouched Phase 12 guards; advance still
  rejects CONFIRMED/FAILED).
- Phase 10–13 guarantees preserved (full suite green).

## Remaining blockers → next phase

Funded wallet, deployed contract, verified proving path, live E2E
execution, core REAL executors behind wallet-attended flow,
`preview`/`mainnet` presets. Recommended next step: provision
undeployed devnet + funding, then execute the runbook above verbatim.
