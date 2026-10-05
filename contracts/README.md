# contracts/ — on-chain enforcement boundary (Phase 4)

## Status: NORMATIVE RULE MODEL, no Compact source yet

- The enforceable state machine lives in `packages/contract/` as pure,
  tested TypeScript: the exact rules future Compact circuits must
  implement 1:1 (entrypoints, guards, replay protection, invariants).
- **No `.compact` file is shipped.** No verified Compact compiler is
  available in this environment, and writing uncompilable contract
  source would invent syntax — explicitly forbidden.
- No fake blockchain functionality is included. Nothing here claims an
  on-chain deployment.

## Toolchain gap (verified 2026-10-06)

- `compact`/`compactc`: not installed. `~/.compact`: absent.
- Midnight npm packages installed locally: none.
- Registry reachable: `@midnight-ntwrk/midnight-js-contracts` latest
  observed at **4.1.1** (observed, not installed, not integrated).

## Planned (Phase 5+, once the compiler is available)

1. Author `contracts/bond.compact` against the verified compiler,
   mirroring `packages/contract/` 1:1.
2. Compile with the verified toolchain; commit artifacts + generated
   TypeScript bindings.
3. Wire bindings through `packages/midnight-adapter/` (the sole seam).

See `docs/phase-4/README.md` for the full VERIFIED / ASSUMED /
UNRESOLVED split.
