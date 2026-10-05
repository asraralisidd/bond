/**
 * Public attestation projections: the privacy boundary for this package.
 *
 * Same rule as Phase 1 projections: fresh allowlisted objects, never
 * spreads. Excluded from public views: verdict `bindingRef`s (future
 * crypto-adjacent material), decision nullifiers (replay-sensitive),
 * rationale content, and any evidence beyond IDs. Only counts, statuses,
 * and the recommended action cross into public.
 */
import type { Attestation, EnforcementAction } from "@bond/shared-types";

export interface PublicAttestationView {
  readonly attestationId: string;
  readonly riskFlagId: string;
  readonly agentId: string;
  readonly status: string;
  readonly threshold: number;
  readonly confirms: number;
  readonly rejects: number;
  readonly abstains: number;
  readonly decisionAction: EnforcementAction | null;
  readonly expiresAt: string;
}

export function toPublicAttestationView(
  attestation: Attestation,
): PublicAttestationView {
  let confirms = 0;
  let rejects = 0;
  let abstains = 0;
  for (const verdict of attestation.verdicts) {
    if (verdict.verdict === "confirm") {
      confirms += 1;
    } else if (verdict.verdict === "reject") {
      rejects += 1;
    } else {
      abstains += 1;
    }
  }
  return {
    attestationId: attestation.attestationId as string,
    riskFlagId: attestation.riskFlagId as string,
    agentId: attestation.agentId as string,
    status: attestation.status,
    threshold: attestation.threshold,
    confirms,
    rejects,
    abstains,
    decisionAction: attestation.decision?.action ?? null,
    expiresAt: attestation.expiresAt,
  };
}
