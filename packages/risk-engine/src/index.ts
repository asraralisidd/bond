/**
 * @bond/risk-engine — FOUNDATION SHELL ONLY.
 *
 * AI risk scoring is NOT implemented. This module intentionally exposes
 * no scoring logic. It exists so imports/builds resolve from day one.
 */

export const RISK_ENGINE_STATUS = "not-implemented" as const;

/** Placeholder stub. Always throws — real scoring is a later milestone. */
export function assessRisk(): never {
  throw new Error(
    "@bond/risk-engine: assessRisk() is not implemented (foundation shell only).",
  );
}
