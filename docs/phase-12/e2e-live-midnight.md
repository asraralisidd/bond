# Phase 12 — End-to-End Live Midnight Lifecycle

Proves and hardens the complete real-world lifecycle against a truthful
Midnight integration boundary, without weakening any Phase 0–11 guarantee.

**REAL NETWORK EXECUTION NOT VERIFIED.** No funded wallet, deployed
contract address, or live Midnight node was exercised in this environment.
Everything below that touches the chain is either:

- **VERIFIED LOCALLY** — deterministic unit/integration tests pass with no
  external infrastructure.
- **INTEGRATION-READY** — code paths are wired against verified installed
  Midnight APIs/types but require external prerequisites to exercise.
- **NOT VERIFIED** — explicitly called out; never claimed as working.

## Architecture (preserved)

```
Browser Wallet (Lace / compatible DApp Connector)
        ↓ connect + sign challenge
BOND API (challenge/verify → session)
        ↓ authenticated operator
Transaction Intent (POST /transactions)
        ↓ advance WALLET_APPROVAL → PENDING
Wallet Approval / Signing (connector.submitTransaction)
        ↓ relayer returns chain tx id
Record Submission (POST /transactions/:id/submitted)
        ↓ PENDING → SUBMITTED + chainTxId
Worker Reconciliation (read-only handle)
        ↓ watchForTxData per row
Authoritative Finality (SucceedEntirely → CONFIRMED)
        ↓ mirror updates via finalizers
BOND State Projection
```

Risk Engine never signs/submits. Attestors never hold operator keys.
Midnight Adapter remains the sole blockchain seam. Backend never receives
private keys or signing secrets.

## Prerequisites for live execution

| Requirement                            | Status            | Notes                                                                                |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `MIDNIGHT_NETWORK=undeployed\|preprod` | INTEGRATION-READY | prod requires explicit value; empty fails startup (`apps/api/src/config.ts:166-171`) |
| `BOND_CONTRACT_ADDRESS`                | MISSING           | must be set to a deployed contract on the chosen network                             |
| `BOND_ZK_ASSETS_PATH`                  | OPTIONAL          | defaults to `contracts/managed/bond`; override if artifacts live elsewhere           |
| Reachable indexer/node/proof-server    | MISSING           | defaults target localhost undeployed; preprod URLs preset in adapter config          |
| Funded operator wallet (Lace)          | MISSING           | browser-injected only; backend never holds keys                                      |
| Deployed BOND contract                 | MISSING           | circuit set unchanged from Phase 4/5; redeploy if network changed                    |
| Network match (wallet ↔ server)        | INTEGRATION-READY | Login checks `/ready` network vs wallet `getNetworkId()` before signing              |

Until all "MISSING" items are satisfied, REAL paths remain unexecuted.
SIMULATED mode continues to work locally for development/tests.

## Transaction lifecycle (truthful states)

| State             | Meaning                                     | How reached                                                     |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `IDLE`            | Intent created, no approval yet             | `POST /transactions`                                            |
| `WALLET_APPROVAL` | Operator approved intent locally            | `POST /:id/advance {WALLET_APPROVAL}`                           |
| `PENDING`         | Wallet approved; ready for submission       | `POST /:id/advance {PENDING}`                                   |
| `SUBMITTED`       | Wallet relayed tx; chain ref recorded       | `POST /:id/submitted {chainTxId}`                               |
| `CONFIRMED`       | Chain finality observed (`SucceedEntirely`) | Worker reconciliation OR `POST /:id/confirm` (REAL handle)      |
| `FAILED`          | Terminal failure with evidence              | Worker reconciliation / confirm path / max-attempts dead-letter |

**Critical invariant:** `CONFIRMED` is written ONLY when
`readTransactionStatus` (adapter `client.ts:578-609`) reports chain
finality for the row's `chain_tx_id`. The advance endpoint rejects
`CONFIRMED`/`FAILED` targets (`transactions.ts:206-217`) — closing the
primary bypass found during recon.

## Read-only reconciliation seam

`connectReadOnly` (`packages/midnight-adapter/src/client.ts:134-170`)
builds a REAL handle whose wallet/private-state providers refuse every
signing/submission call (`providers.ts:78-145`). The worker uses this
handle (`worker/registry.ts:29-38`) so it can observe finality without
ever holding keys.

`reconcileTransactionRows` (`services/reconcile.ts:140-260`) resolves
SUBMITTED rows one at a time:

- `CONFIRMED` → DB `CONFIRMED` + `confirmed=true` + purpose finalizer
  (exactly once via row-lock + status check).
- `FAILED` → DB `FAILED` with `MIDNIGHT_CONFIRMATION_FAILED`.
- Unreachable/unknown → row untouched; next pass retries.
- Non-SUBMITTED / no `chain_tx_id` → skipped.

Chain state wins. Local projections never manufacture confirmation.

## Worker behavior (REAL)

- Never submits transactions (refusing wallet provider makes blind
  submission impossible).
- Resolves SUBMITTED rows via `reconcileTransactionRows` each poll.
- Agent/bond mirror healing (`runReconciliationOnce`) unchanged.
- SIMULATED rows await explicit operator `/confirm` (dev-only, auditable).

## Frontend honest labels

`TxBadge` (`apps/web/src/components/lifecycle.tsx:67-105`) renders:

| Status            | Label                    |
| ----------------- | ------------------------ |
| `IDLE`            | Draft                    |
| `WALLET_APPROVAL` | Awaiting Wallet Approval |
| `PENDING`         | Awaiting Submission      |
| `SUBMITTED`       | Submitted                |
| `CONFIRMED`       | Confirmed                |
| `FAILED`          | Failed                   |

SIMULATED receipts carry an explicit `SIMULATED` badge. REAL `SUBMITTED`
never displays as confirmed. Mode derivation uses `chainTxId` presence
only as a hint; truth comes from the `status` field.

`api.recordWalletSubmission(id, chainTxId)` is now exposed
(`apps/web/src/api/client.ts:249-252`) for wallet-relay flows.

## Security / truthfulness audit

- **Advance bypass closed:** `POST /:id/advance {CONFIRMED|FAILED}` → 400
  `INVALID_TRANSACTION_TRANSITION` (tested).
- **Read-only providers non-custodial:** wallet stub throws on
  `balanceTx/getCoinPublicKey/getEncryptionPublicKey/submitTx`; private
  state Proxy throws on any method (tested).
- **Reconciliation idempotent:** row-lock + SUBMITTED check prevents
  double-finalizer application; already-CONFIRMED rows skipped.
- **No silent REAL→SIMULATED fallback:** `connectReadOnly` throws on
  non-REAL config; worker logs error and continues without touching rows.
- **No secret leakage:** read-only handle carries no keys; logs emit only
  tx ids, statuses, and operation names.
- **Phase 10 guarantees preserved:** BOLA checks, strict ID parsing,
  rate limits, safe error envelope, ownership enforcement all untouched.

## Testing

`apps/api/src/phase12-reconciliation.test.ts` (8 tests, all passing):

- Advance to CONFIRMED/FAILED rejected without finality.
- Read-only provider refuses wallet/private-state ops.
- `connectReadOnly` rejects non-REAL config.
- Reconciliation skips non-REAL handles, non-SUBMITTED rows, rows
  without chain refs.
- `readTransactionStatus` rejects non-REAL handles.
- `sim-*` chain refs never treated as REAL confirmation.

Full suite: **55 files / 323 tests pass** (was 54/315; +8 new, zero
regressions).

## Known limitations / residual risks

- **Live network not exercised.** All REAL paths are coded against
  verified installed APIs but unexecuted. See prerequisites table above.
- **`submitRealCall` has no production caller for core ops.** Only
  eligibility wrappers use it today. Core lifecycle circuits
  (registerAgent, lockBond, activateAgent, etc.) remain SIM-only in
  executors. Wallet-mediated balancing/proving delegation is future work.
- **Address↔key ownership unproven.** Sessions bind the signing key; no
  on-chain proof links address to key. Documented honestly.
- **Wallet challenge expiry purge missing.** Rows accumulate; index exists
  but no deleter. Operational concern, not a correctness bug.
- **Session wallet-key not enforced server-side.** Account-switch
  protection is client-only (`signInWithWallet` overwrites state). Server
  `requireAuth` does not compare `sessions.wallet_verifying_key`. Tracked
  as Phase 11 residual; not required for Phase 12 correctness.
- **`mainnet`/`preview` networks rejected.** No verified endpoint presets;
  fail-closed by design until presets are added and verified.

## Validation results

| Check                  | Result                              |
| ---------------------- | ----------------------------------- |
| `npm run typecheck`    | ✅ pass                             |
| `npm run lint`         | ✅ pass                             |
| `npm run format:check` | ✅ pass                             |
| `npm test`             | ✅ 55 files / 323 tests             |
| `npm run build`        | ✅ pass (run before checkpoint)     |
| `git diff --check`     | ✅ clean                            |
| Secret sweep           | ✅ no keys/seeds/signatures in diff |

## Files changed

Modified (6): `apps/api/src/services/{reconcile,transactions}.ts`,
`apps/api/src/services/worker/{registry,runtime}.ts`,
`packages/midnight-adapter/src/{client,providers}.ts`.
New (2): `apps/api/src/phase12-reconciliation.test.ts`,
`docs/phase-12/e2e-live-midnight.md`.
Frontend: `apps/web/src/api/client.ts` (+`recordWalletSubmission`).

## Recommendation for Phase 13

1. Deploy BOND contract to undeployed devnet; set `BOND_CONTRACT_ADDRESS`.
2. Exercise full E2E: wallet connect → challenge → submit → reconcile →
   CONFIRMED on a funded bond lifecycle.
3. Wire `submitRealCall` production callers for core ops with
   wallet-mediated balancing.
4. Add challenge-expiry purge job.
5. Enforce `sessions.wallet_verifying_key` server-side on `requireAuth`.
6. Enable `preview`/`mainnet` after verifying endpoint presets.

</content>
