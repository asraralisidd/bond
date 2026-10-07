# Phase 25 — Real Midnight Integration (operator ceremony runbook)

Moves BOND from the verified SIMULATED path toward REAL Midnight
execution without weakening any boundary. The adapter already
contains every REAL seam; the backend stays non-custodial; this
document describes the environment-led ceremony that activates
them.

Status at writing: **SIMULATED is the only executed path.**
Preprod endpoints answer read-only probes from some networks;
no funded wallet, deployed contract, or proof-server availability
is established here. Nothing below fabricates live execution.

## 1. Architecture (unchanged)

```
BOND API (intents, recording, confirmation, reconciliation)
  ↓ resolveMidnightConfig → SIMULATED | REAL | UNAVAILABLE
Midnight Adapter (sole chain seam)
  ├─ SIMULATED: normative @bond/contract rules, `sim-` receipts
  ├─ REAL submit: submitRealCall / submitEligibility* / deployBondContract
  │   (require an injected WalletAndMidnightProvider — nothing in-repo
  │   provides one; the browser/Lace wallet does, wallet-attended)
  └─ REAL read-only: connectReadOnly (refusing wallet stub) for the
      worker, /ready, and reconciliation
Browser wallet (Lace/compatible, user-controlled)
  → challenge auth today; relayed submission + deployment tomorrow
Midnight network (undeployed local devnet, then preprod)
  → Compact contract (12 circuits, artifacts complete)
```

SIMULATED must never become CONFIRMED merely because an adapter
method returned successfully. REAL failures must never silently
fall back to SIMULATED (worker flags `uncertain`; config throws
`UNAVAILABLE`).

## 2. Supported networks

Only networks with verified presets: **`undeployed`** (local
devnet: indexer :8088, node :9944, proof server :6300) and
**`preprod`** (public indexer/RPC, local proof server).
`preview` and `mainnet` are rejected by configuration —
fail-closed, no inheritance of preprod endpoints. First target:
`undeployed`; repeat on `preprod` once funded.

## 3. Wallet requirements (non-custodial — absolute)

- A user-controlled browser wallet (Lace or API-compatible),
  connected to the target network (server validates network id
  on challenges).
- The wallet funds its own fees; the backend never holds keys.
- NEVER: request/store/write/print/commit a private key, seed,
  witness, salt, or signing secret. No wallet tables, no key env
  vars, no key material to the backend — challenge signatures
  only, as today.
- Known limitation: address↔verifying-key ownership has no
  verified primitive in the installed stack. Sessions stay
  key-bound; never address-bound. Do not claim otherwise.

## 4. Funding requirements (environment, per network)

Funded operator wallet with native test tokens covering deployment

- per-purpose submissions + proof fees, plus a reachable proof
  server (default `http://127.0.0.1:6300`; image
  `midnightntwrk/proof-server:8.1.0` is the verified reference) and
  `BOND_ZK_ASSETS_PATH` resolvable in the API runtime
  (defaults to `contracts/managed/bond`).

## 5. Environment variables

| Variable                                                             | Required when                 | Notes                                                                                  |
| -------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `MIDNIGHT_NETWORK`                                                   | always explicit in production | `undeployed`/`preprod`→REAL; empty/`simulated`→SIMULATED; `mainnet`/`preview` rejected |
| `BOND_CONTRACT_ADDRESS`                                              | production + REAL             | startup fails without it                                                               |
| `MIDNIGHT_INDEXER_HTTP/_WS`, `MIDNIGHT_NODE_URL`, `PROOF_SERVER_URL` | REAL                          | preset defaults per network; override as needed                                        |
| `BOND_ZK_ASSETS_PATH`                                                | optional                      | defaults to managed artifacts                                                          |
| `BOND_E2E_LIVE=1`                                                    | live tests only               | without it, live tests skip                                                            |

## 6. Deployment ceremony

PREPARE → VERIFY → FUND → DEPLOY → RECORD → CONFIGURE → /READY →
SUBMIT → CONFIRM → RECONCILE.

1. **PREPARE.** `npm run build`. Copy
   `docs/phase-25/deployment-record.TEMPLATE.json` to
   `deployment-record.<network>.json` (outside committed paths).
2. **VERIFY.** `node scripts/deploy-contract.mjs --dry-run` with
   `MIDNIGHT_NETWORK` set: 12/12 artifacts, toolchain,
   endpoints. Then `--live`: expect exit 1 reporting the exact
   wallet-attended prerequisites (this is the seam check, not a
   failure).
3. **FUND.** Fund the operator wallet out-of-band; note network,
   token, and approximate balance in the record (no addresses
   holding secrets, no keys — ever).
4. **DEPLOY.** Through the wallet-attended flow, invoke the
   existing `deployBondContract(handle, { initialPrivateState })`
   seam with an injected provider and operator-supplied private
   state. The Node CLI cannot do this step (no fake wallets).
   Obtain the deployment tx id and contract address.
5. **RECORD.** Fill the deployment record; validate with
   `node scripts/verify-deployment-record.mjs <record>
--check-toolchain` (exit 0 required; rejects placeholders,
   non-allowlisted networks, malformed fields, and any
   secret-like material).
6. **CONFIGURE.** Set `BOND_CONTRACT_ADDRESS` (compose/env);
   never commit secrets alongside it.
7. **/READY.** `checks.midnight.contract.status` must read
   `reachable` (read-only `findBondContract`, 5s bound, leaks
   nothing). `ready: false` means stop.
8. **SUBMIT.** Per purpose (register, lock, activate,
   eligibility prove/consume, enforce, release, withdraw):
   create the API intent → wallet submits via connector →
   `POST /transactions/:id/submitted` records the chain
   reference (conflict-safe; a claim is never confirmation).
   Unique idempotency keys per run.
9. **CONFIRM.** Worker confirm-sweeps or explicit confirm read
   `SucceedEntirely` finality only. Anything else stays pending
   or fails — never invented.
10. **RECONCILE.** Run reconciliation; chain state wins; target
    zero unexplained conflicts after settling.

## 7. First real transaction (per-purpose matrix)

For each of agent registration, bond lock, activation,
eligibility prove/consume, enforcement, release, withdrawal:
intent → wallet submission → chainTxId → SUBMITTED → worker
confirmation → CONFIRMED → reconciliation. Database state must
match verified chain reads (`readPublicState`,
`readEligibilityRecord`) before moving on.

## 8. Wallet-relayed submission (existing lifecycle — reused)

`PENDING → SUBMITTED` records the wallet's chain reference only;
confirmation comes exclusively from finality; conflicting
references 409; malformed references 400; duplicate recording
fails closed; cross-operator recording is forbidden. The worker
never submits on REAL handles — uncertain intents wait for the
wallet or reconcile against references already recorded.

## 9. Confirmation and reconciliation (existing — reused)

CONFIRMED requires `SucceedEntirely`; anything else observed is
FAILED; unreachable/unknown references throw so rows stay
pending. Finalizers run exactly once (status-guarded).
`runReconciliationOnce` heals DB mirrors from chain reads with
`CHAIN_DIVERGENCE_DETECTED` audit. SIMULATED rows await explicit
operator confirmation by design and are never touched by REAL
sweeps.

## 10. Eligibility/ZK execution (existing path)

`proveEligibility` / `revokeEligibility` / `consumeEligibility`
circuit args are built from validated public inputs; private
amount/salt/secret stay in per-call private state; nullifiers
bind agent/purpose/nonce with replay protection. Use the existing
lifecycle (`CREATED→SUBMITTED→VERIFIED→CONSUMED`) and the
existing proof-server integration. No ZK redesign (Phase 26
owns hardening).

## 11. Troubleshooting

- `/ready` contract `unreachable`: endpoints down or address
  wrong — check network, address, indexer; rows stay pending.
- `MIDNIGHT_UNAVAILABLE` on submit paths: no injected wallet —
  expected server-side; submit via the wallet flow.
- Conflicting chain refs (409): two realities recorded; keep
  the confirmed one, investigate the other — never overwrite.
- Unknown status after sweeps: normal transient; next pass
  retries; do not resubmit blindly (chain-tx-id resume prevents
  duplicates).
- Proof failures: check proof-server reachability and ZK assets
  path before suspecting witnesses.

## 12. Rollback/recovery

No chain rollback exists (by Midnight's nature). Recovery is
forward-only: failed intents dead-letter with reasons; stuck
SUBMITTED rows reconcile against finality; DB mirrors heal from
chain reads. To abandon a deployment: stop traffic (`ready`
503), deploy a fresh instance with `--replace` acknowledgment,
record the new address, and re-anchor agents (SIMULATED history
is unaffected — it was never chain state).

## 13. Security rules (non-custodial restated)

No private keys, seeds, witnesses, salts, or signing material in
env, DB, logs, events, errors, tests, source, images, or records
(verifier enforces this on records; tests enforce it on code
paths). Operator-only recording with ownership checks. Generic
401/403/404/409 surfaces (no existence oracles). No mainnet
without a verified preset + safety review (out of scope).

## 14. SIMULATED vs REAL behavior

SIMULATED: labeled receipts, in-memory normative rules, explicit
operator dev-confirm, never presented as chain activity.
REAL: wallet-attended submission, finality-only confirmation,
chain-wins reconciliation. The two modes share request shapes
but never share execution: mode-mismatched calls throw.

## 15. Known blockers (current environment)

No funded wallet obtainable here (creating keys is forbidden);
no deployed contract (`BOND_CONTRACT_ADDRESS` empty); no local
devnet processes (ports 8088/9944/6300 refused); preprod reads
reachable but unwritable without a wallet. Local proof-server
image is cached but unstarted (irrelevant until submission
exists). All live acceptance items therefore remain
environment-blocked; every offline item is implemented.

## 16. [VERIFY-MIDNIGHT] items

Endpoint reachability at ceremony time; faucet/funding mechanics;
proof-server image currency; midnight-js 4.1.1 API currency
(`test:live` fails loudly on drift — run it first); fee/funding
headroom; `undeployed` devnet bring-up for the current release;
exact address format expectations of `findDeployedContract`
against a real deployment.
