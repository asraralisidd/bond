# Phase 13 — Real E2E Midnight & Production Wallet Hardening

**LIVE NETWORK EXECUTION: BLOCKED / NOT VERIFIED.**

Reason:

- no funded wallet available in this environment
- no deployed BOND contract / `BOND_CONTRACT_ADDRESS` available
- no reachable verified Midnight environment (indexer/node/proof-server) available

Nothing in this phase fabricates live execution. All claims below are
labeled; SIMULATED results are never described as live.

## Status labels

- **VERIFIED LOCALLY** — deterministic tests pass with no external infra.
- **INTEGRATION-READY** — wired against verified installed APIs; needs
  external prerequisites to exercise.
- **LIVE-NETWORK VERIFIED** — exercised against a real Midnight network.
  (None in this phase.)
- **BLOCKED / NOT VERIFIED** — explicitly deferred or impossible here.

## 1. Wallet session hardening — VERIFIED LOCALLY

Phase 11 wrote `sessions.wallet_verifying_key` but never read it.
Phase 13 closes the gap:

- `SessionRow` now carries `auth_method`, `wallet_verifying_key`,
  `challenge_id` (`apps/api/src/db/stores/operators.ts`).
- `findSessionByTokenHash` selects them (`operators.ts:81-85`).
- `AuthContext` propagates `authMethod` + `walletVerifyingKey`
  (`apps/api/src/http/auth.ts`); every ownership check continues to
  derive identity from `operatorId` (unchanged Phase 10 semantics).
- Sessions are cryptographically bound at issuance: the verifying key
  that produced the accepted signature is written on the session row and
  cannot change for the session's lifetime (no update path exists).

Identity separation preserved: dev sessions (`auth_method='dev'`, null
vk) and wallet sessions (`auth_method='wallet'`, vk set) never share
operator ids (`op_<externalKey>` vs `op_w_<vk>`). Production remains
fail-closed (`DEV_AUTH_TOKEN` forbidden in prod — unchanged).

Account switching: an in-wallet account switch is unobservable to the
server (bearer tokens carry no wallet state). The old session remains
valid until expiry/revocation; a new sign-in creates a distinct operator.
Client-side handling (full state reset on `signInWithWallet`, sign-out
revokes server-side) is unchanged from Phase 11. Server-side per-request
wallet re-attestation is impossible without a per-request signature —
documented as a known limitation, not silently claimed.

## 2. Challenge expiry cleanup — VERIFIED LOCALLY

`purgeExpiredChallenges()` (`apps/api/src/services/challenge-cleanup.ts`):

- Deletes ONLY `consumed_at IS NULL AND expires_at < now()` rows.
- Consumed challenges are retained (audit trail; replay still fails via
  the atomic consume guard).
- Idempotent (repeat runs delete 0).
- Race-safe: the purge can never invalidate a verification that would
  succeed. Verification consumes via `UPDATE … WHERE consumed_at IS NULL`
  inside the session-issuing transaction; the purge only matches rows
  that are already expired — and expired challenges fail verification
  regardless (`Challenge expired` 401). Worst case, a purge concurrent
  with a just-expired verification deletes the row first and the
  verifier sees `Unknown or expired challenge` — fail-closed either way.
- Uses the existing `wallet_challenges_expires_idx`; a single indexed
  DELETE — no scheduler, no new infrastructure.
- Integrated opportunistically in `requestWalletChallenge` (fail-safe:
  cleanup errors never block issuance; frequency bounded by the auth
  rate limit).

## 3. Shielded coin public key exposure — VERIFIED LOCALLY

The verified connector API (`getShieldedAddresses()`) returns
`shieldedCoinPublicKey`; the Phase 11 connector discarded it. Now
surfaced in `WalletAddresses` (`apps/web/src/wallet/connector.ts`).

**Ownership relationship is NOT independently proven:** this is
available wallet key material exposed by the connector — no API exists
in the installed stack (`wallet-sdk-address-format` is bech32m
encode/decode only; no key-derivation or ownership-proof surface) to
prove address ↔ verifying-key ownership. No such claim is made anywhere.

## 4. Core REAL operations — investigation only

Per-operation requirements from installed APIs
(`submitCallTxAsync` handles prove→balance→submit via the provider
pipeline; `WalletProvider.balanceTx` performs wallet-mediated balancing;
`watchForTxData` → `SucceedEntirely` = finality). Backend records the
resulting chain reference (`POST /:id/submitted`) and reconciles
(`reconcileTransactionRows`, Phase 12). No private keys reach the
backend in any design below.

| Operation                       | Circuit                                                         | Public inputs                                            | Private inputs (witness)                         | Status                                                                                                  |
| ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Register agent                  | `registerAgent`                                                 | agentId (Bytes32)                                        | operatorSecret                                   | SIMULATED ONLY                                                                                          |
| Lock bond                       | `lockBond`                                                      | bondId, agentId                                          | operatorSecret, commitmentAmount, commitmentSalt | SIMULATED ONLY                                                                                          |
| Activate                        | `activateAgent`                                                 | agentId                                                  | operatorSecret                                   | SIMULATED ONLY                                                                                          |
| Flag / enforcement              | `flagAgent` / `processEnforcement`                              | agentId / +bondId, nullifier, action(U8), amount(U64)    | operatorSecret (+commitment)                     | SIMULATED ONLY (REAL arg builder `enforcementCircuitArgs` exists)                                       |
| Resolve / reactivate            | `resolveAgent` / `reactivateAgent`                              | agentId                                                  | operatorSecret                                   | SIMULATED ONLY                                                                                          |
| Release / withdraw              | `releaseBond` / `withdrawBond`                                  | bondId                                                   | operatorSecret, commitmentAmount, commitmentSalt | SIMULATED ONLY                                                                                          |
| Eligibility prove/revoke/redeem | `proveEligibility` / `revokeEligibility` / `consumeEligibility` | agentId, policyHash, purpose, requiredMinimum, nullifier | operatorSecret, commitmentAmount                 | INTEGRATION-READY (REAL wrappers `submitEligibilityProof/Revocation/Redemption` wired; unexecuted live) |

Common wallet requirements for any REAL submission: injected
`WalletAndMidnightProvider` (balancing + submission), private-state
provider seeded by the wallet layer, proof server reachable, deployed
`BOND_CONTRACT_ADDRESS`, matching `networkId`. Submission returns the
chain tx id; finality is observed by the read-only reconciliation path.
Why core ops remain SIMULATED: they are invoked by the backend worker /
service layer, which never holds a wallet — making them REAL requires
the wallet-attended flow (browser builds/balances/seals, relays via
connector, records via `/submitted`). That flow needs serialization/
balancing APIs exercised against a live wallet and is therefore
BLOCKED here, not faked.

## 5. Address / key ownership — BLOCKED / NOT VERIFIED

No verified installed API proves address ↔ verifying-key ownership.
Nothing invented. The wallet signature / verifying-key binding (Phase 11) remains the strongest verified identity. `shieldedCoinPublicKey` is
exposed as unclaimed material for future work.

## 6. Reconciliation — VERIFIED LOCALLY (architecture), Phase 12 intact

Unchanged guarantees: chain finality authoritative; SUBMITTED rows only;
row locking; exactly-once finalization; unknown rows untouched; no
confirmation inference; no REAL→SIMULATED fallback
(`connectReadOnly` throws on non-REAL config). Phase 12's
`reconcileTransactionRows` + `readTransactionStatus` are untouched this
phase; regression-tested in `phase12-reconciliation.test.ts`.

## 7. Security review — findings

- **Wallet identity confusion:** operators derive deterministically from
  the verifying key (`op_w_<vk>`); two wallets never share an operator.
  Tested.
- **Session fixation:** fresh random token per issuance; only hashes
  stored; fixation impossible (no session reuse across logins). Tested.
- **Account switching:** distinct operators per key; cross-access 403.
  Tested. Old-session persistence after in-wallet switch documented as a
  limitation (cannot be observed server-side without per-request
  signatures).
- **Challenge replay:** atomic single-use consume; replay 401. Tested.
- **Challenge expiry/purge race:** purge targets only expired+unconsumed;
  consume remains authoritative. Tested both orders.
- **Private-key leakage:** no key/signature persistence (DB scan test);
  no keys in logs (Phase 10 allowlist logging unchanged).
- **Authorization bypass:** Phase 10 BOLA/ownership/rate-limits untouched;
  full suite green.
- **Fake confirmation / REAL→SIM fallback:** advance endpoint still
  rejects CONFIRMED/FAILED (Phase 12 guard, regression-tested);
  `connectReadOnly`/`readTransactionStatus` reject non-REAL handles.
- **Malicious contract/network configuration:** unchanged fail-closed
  behavior (unknown networks throw; mainnet/preview rejected; prod
  requires explicit `MIDNIGHT_NETWORK`).

## 8. Tests

- `apps/api/src/phase13-wallet-hardening.test.ts` (12): session binding,
  dev/wallet separation, revoked/expired wallet sessions, account
  switching, same-key re-auth identity, purge semantics (expired/
  unexpired/consumed/idempotent/purge-then-verify), opportunistic purge
  at issuance, no-secret persistence scan, REAL/SIM separation.
- `apps/web/src/test/wallet-phase11.test.tsx` (+1): connector coin-key
  exposure with no ownership claim.
- `apps/api/src/test-helpers.ts`: `wallet_challenges` added to the
  reset list (was missing since migration 010 — pre-existing test-gap
  fix, not a test weakening).

## 9. Validation

| Check                  | Result                                                  |
| ---------------------- | ------------------------------------------------------- |
| `npm run typecheck`    | ✅                                                      |
| `npm run lint`         | ✅                                                      |
| `npm run format:check` | ✅                                                      |
| `npm test`             | ✅ (see final report for counts)                        |
| `npm run build`        | ✅                                                      |
| `git diff --check`     | ✅                                                      |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities (no dependency changes this phase) |

## 10. Remaining risks / blockers

- Live core-operation execution (wallet-attended flow) — BLOCKED.
- Address↔key ownership proof — BLOCKED (no API).
- `preview`/`mainnet` — rejected until verified presets exist.
- Old wallet session survives in-wallet account switch until
  expiry/revocation (server-unobservable).

## 11. Recommended next phase

1. Funded undeployed devnet + deployed contract → exercise eligibility
   REAL path end-to-end (INTEGRATION-READY today).
2. Wallet-attended core-op flow: browser-side call building/balancing →
   connector relay → `/submitted` → reconciliation.
3. Verify `preview` presets officially, then enable.
4. Consider optional per-request wallet re-attestation headers if the
   connector ecosystem supports cheap re-signing.
