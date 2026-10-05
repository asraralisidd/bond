/**
 * @bond/midnight-adapter — contract boundary seam (Phase 4).
 *
 * Sole TypeScript seam between the application and Midnight. In Phase 4
 * it carries validated, contract-compatible request shapes plus versioned
 * contract metadata — NO generated modules (no compiler available yet),
 * NO submission, NO signing, NO network. Real chain wiring is Phase 5.
 */
export const MIDNIGHT_ADAPTER_STATUS = "adapter-boundary-v1" as const;

export * from "./versions.js";
export * from "./metadata.js";
export * from "./requests.js";

/**
 * Chain connection. Still a stub: establishing sessions, wallets, and
 * deployment uses generated modules + compiled artifacts that do not
 * exist yet (see docs/phase-4). Always throws — never fake a connection.
 */
export function connectMidnight(): never {
  throw new Error(
    "@bond/midnight-adapter: on-chain connection requires compiled contract artifacts (Phase 5).",
  );
}
