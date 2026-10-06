# Phase 11 — Real Midnight + Wallet Integration

Moves BOND from dev-key sessions and a SIMULATED-only transaction boundary
toward truthful wallet authentication and real Midnight lifecycle — without
weakening any Phase 0–10 boundary. The Risk Engine still cannot touch
transactions; SIMULATED is never presented as CONFIRMED; the Midnight
Adapter remains the sole chain seam.

**REAL NETWORK EXECUTION NOT VERIFIED.** No funded wallet, devnet node,
or live submission was exercised: the REAL submit path (`submitRealCall`)
has no production caller yet and the worker refuses REAL blind submission
by design. Everything below that is verified runs in tests unless marked
REAL (coded, unexecuted) or VERSION-SENSITIVE.

## 1. Reconnaissance

Installed stack (pinned, inspected — nothing assumed from memory):
`compact-js 2.5.1`, `compact-runtime 0.16.0`,
`midnight-js-{contracts,http-client-proof-provider,indexer-public-data-provider,network-id,node-zk-config-provider,protocol,types,utils} 4.1.1`,
`wallet-sdk-address-format 3.1.2`, `ledger-v8` (via compact-runtime),
`onchain-runtime-v3`, `platform-js`. No dapp-connector, wallet SDK, or
Lace package is installed — wallets are injected, never bundled.

Connector surface (VERIFIED from the published `dapp-connector-api@4.0.1`
tarball, matching the 4.x family): `window.midnight[rdns]` initial API,
`connect(networkId)`, `signData(data, {encoding:'text',
keyType:'unshielded'})` → `{data, signature, verifyingKey}` (hex),
`getConfiguration()` → `{networkId, ...}`, `getUnshieldedAddress()`,
`getShieldedAddresses()`, `submitTransaction(sealedTx)`.

Server verification (VERIFIED locally): ledger `verifySignature(vk, data,
sig)` accepts genuine signatures and rejects tampered data (Schnorr/BIP340;
32-byte vk hex, 64-byte signature hex). Address↔key ownership has NO
verified primitive in this stack — the design therefore binds sessions to
the key that signed, and claims no address ownership.

Adapter state: 12 circuits compiled, SIMULATED executors for all core ops,
REAL `submitRealCall` wired but caller-less, `confirmOperation` finality
truthful (SucceedEntirely only). Worker REAL-guarded (reconciliation, not
submission). `MIDNIGHT_NETWORK=""` defaulted to SIMULATED even in prod.

## 2. Wallet architecture

```
Lace / compatible wallet (injected window.midnight, never bundled)
  │ connect(networkId) → signData(challenge) [user-approved]
  ▼
React (connector.ts: connect, network check, sign, relay)
  │ POST /auth/wallet/challenge → canonical message
  │ POST /auth/wallet/verify { challengeId, signature }
  ▼
BOND API (services/wallet-auth.ts: issue, expire, single-use, bind)
  │ verifyWalletSignature via @bond/midnight-adapter (sole crypto seam)
  ▼
Session (op_w_<verifyingKey>, auth_method='wallet') → Phase 10 ownership
  ▼
Tx intent → PENDING → wallet submits via connector → POST /:id/submitted
  → SUBMITTED → confirmOperation finality → CONFIRMED (worker sweeps)
```

## 3. Authentication protocol

`POST /api/v1/auth/wallet/challenge {network?}` → 201
`{challengeId, nonce, network, message, expiresAt}`. Server stores the
canonical `message` verbatim (never recomputed from re-formatted
timestamps). `POST /api/v1/auth/wallet/verify {challengeId, signature}`
→ 201 `{token, operatorId, sessionId}`. Single-use enforced atomically
(`UPDATE … WHERE consumed_at IS NULL` inside the session-issuing
transaction). Challenges expire (5 min default, `WALLET_CHALLENGE_TTL_MS`
bounded 60s–30min). Replays, expired/unknown/consumed challenges,
wrong-domain messages, network-tampered messages, key mismatches, and
malformed payloads all fail closed (401/400, safe envelope). Both
endpoints carry the strict `auth` rate-limit policy. Signatures are never
stored; sessions store token hashes only.

## 4. Wallet identity model

`op_w_<verifyingKey>` (full 64-hex key — collision-free). Session rows
carry `auth_method` + `wallet_verifying_key` + `challenge_id`. Ownership
checks are unchanged: the wallet operator flows through the exact same
`require*Ownership` helpers as dev operators. Address ownership is NOT
claimed (no verified primitive — stated, not hidden).

## 5. Frontend wallet flow

Login: wallet list from `window.midnight` (empty → install-Lace notice) →
select → `/ready` gives the server network → connect → REAL deployments
require wallet-network match → challenge → wallet signs (approved) →
verify → `signInWithWallet` (full identity reset — no silent account
carryover). Disconnect/sign-out clears token + operator + wallet binding.
Hostile wallet names render as text. Chrome shows network truthfully
(from `/ready`: REAL network, else SIMULATED) and wallet identity as
`wallet:<8hex>… @ network`. TxBadge uses honest labels (Awaiting Wallet
Approval / Submitted / Confirming-adjacent states never claim success;
CONFIRMED only on finality; SIMULATED always badged).

## 6. Midnight network configuration

Production MUST set `MIDNIGHT_NETWORK` explicitly (startup throws
otherwise — empty no longer silently means SIMULATED). Adapter rejects
`mainnet`/`preview` (no verified endpoint preset; must not inherit
preprod URLs). REAL still requires injected wallet + contract address
(fail-closed, unchanged). `.env.example` documents the wallet vars.

## 7. Adapter design

New `wallet.ts` in `@bond/midnight-adapter` (sole seam): canonical
message builder, structural signature parsing, `verifyWalletSignature`
(fail-closed boolean), `isValidMidnightAddress` (syntactic bech32m only).
`index.ts` re-exports it; `wallet-sdk-address-format@3.1.2` added as a
real dependency. No crypto invented; every primitive provenance-noted.

## 8. Transaction lifecycle

`PENDING → SUBMITTED` has a new honest path: `POST /:id/submitted
{chainTxId}` — the wallet submits through the connector (relayer) and
the API records the chain reference on the caller's OWN pending intent
(BOLA-checked). It is recording, not confirmation: CONFIRMED still comes
only from `confirmOperation` finality (operator `/confirm` or worker
sweeps). Conflicting references → 409; non-PENDING → 400. Worker REAL
behavior unchanged (refuses blind submission → reconciliation).

## 9. Contract mapping

Unchanged: the 9 TS-mirrored entrypoints + 3 eligibility circuits map as
before. No new circuits; no contract edits; managed artifacts untouched.
REAL submission wiring for core ops remains future work (submitRealCall
needs a wallet-attended caller — Phase 12).

## 10. Worker behavior

Unchanged by design: REAL intents go `uncertain → reconciliation_required`
rather than blind-submit; `confirmSweep`/`reconciliationSweep` resolve via
finality; SIMULATED paths untouched. No backend signing invented; no keys
stored; uncertain submission never retried blindly.

## 11. Reconciliation

Unchanged: chain authoritative, DB mirrors; `recordWalletSubmission` only
stores the operator-relayed reference — finality still decides CONFIRMED.

## 12. Security model

All Phase 10 guarantees preserved and re-tested (full suite green):
BOLA (wallet A vs B tested), strict ids, ownership, rate limits (wallet
endpoints under `auth` policy), safe errors/logs, replay/idempotency,
state machines, privacy. New attack coverage: spoofed/rotated wallets,
replay, expiry, wrong domain/network, disconnect staleness, cross-operator
tx/bond/agent access.

## 13. Privacy model

Public projections unchanged; sessions expose no secrets; wallet identity
shown truncated; signatures/addresses never logged; HTTP clients carry no
key material.

## 14. Environment variables

New: `WALLET_CHALLENGE_TTL_MS` (optional, 60s–30min, default 5min).
Changed semantics: `MIDNIGHT_NETWORK` required in production; `mainnet` /
`preview` rejected by the adapter. Documented in `.env.example`.

## 15. Test strategy

- `packages/midnight-adapter/src/wallet.test.ts` (4): canonical message,
  genuine sign/verify incl. cross-key rejection, malformed fail-closed,
  address shape.
- `packages/midnight-adapter/src/config.test.ts` (+1): mainnet/preview
  fail-closed.
- `apps/api/src/wallet-auth.test.ts` (13): issuance, network mismatch,
  valid→session+agent use, invalid/garbage/wrong-domain/unknown/expired/
  replayed/malformed, network-tampered message, wallet A/B isolation,
  submitted lifecycle incl. conflict + non-PENDING, no secret storage.
- `apps/api/src/production.test.ts` (+): prod network requirement +
  existing CORS/dev-auth cases updated for the new required var.
- `apps/web/src/test/wallet-phase11.test.tsx` (3): no-wallet state,
  hostile wallet-name inertness, honest labels + SIMULATED badging.
- Privacy TxBadge test updated to honest labels.

## 16. Version-sensitive Midnight APIs

SUPPORTED (verified): connector 4.0.1 shape; ledger sign/verify;
bech32m parse; `WalletProvider`/`MidnightProvider` interfaces;
`submitCallTxAsync`/`watchForTxData` semantics. REAL (coded, unexecuted):
`submitRealCall`, `confirmOperation` against live infra, wallet-mediated
balancing (`balanceUnsealedTransaction`), proving delegation. UNVERIFIED:
any address↔key ownership proof; wallet UX strings (rdns/name/icon
handling per connector docs — names treated as hostile).

## 17. Known limitations

No funded-wallet/devnet execution (REAL NOT VERIFIED); address ownership
unproven (sessions bind the signing key); worker cannot submit REAL;
`submitRealCall` caller-less for core ops; `preview`/`mainnet` disabled;
challenge table needs periodic expiry purge (index present; no deleter
yet — consumed rows accumulate).

## 18. Deployment requirements

REAL deployment needs: funded operator wallet (Lace/compatible),
reachable indexer/node/proof endpoints, deployed contract address +
`BOND_ZK_ASSETS_PATH`, `MIDNIGHT_NETWORK=undeployed|preprod` (prod
explicit), `WALLET_CHALLENGE_TTL_MS` optional, `DEV_AUTH_TOKEN` unset in
prod (existing fail-closed). No secrets in env beyond existing DB config.

## 19. Phase 12 dependencies

Funded-wallet live execution (submit→confirm→reconcile on undeployed);
wallet-mediated balancing for value-moving circuits; address↔key
ownership story; challenge-expiry purge; `submitRealCall` production
caller for core ops; mainnet/preview enablement with verified presets;
attestor assignment persistence (carried from Phase 10).
