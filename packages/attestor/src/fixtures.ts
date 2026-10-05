/**
 * Shared test fixtures (not a test file: no assertions here).
 */
import {
  createRiskFlag,
  parseAgentId,
  parseEvidenceId,
  parseRiskFlagId,
} from "@bond/shared-types";
import type { RiskFlag, RiskSeverity } from "@bond/shared-types";
import { createAttestor } from "./attestor.js";
import type { AttestorProfile } from "./attestor.js";

export function makeFlag(overrides?: {
  readonly severity?: RiskSeverity;
  readonly confidence?: number;
  readonly flagId?: string;
  readonly agentId?: string;
  readonly status?: RiskFlag["status"];
}): RiskFlag {
  return createRiskFlag({
    riskFlagId: parseRiskFlagId(overrides?.flagId ?? "flag-001"),
    agentId: parseAgentId(overrides?.agentId ?? "agent-001"),
    category: "unauthorized-action",
    severity: overrides?.severity ?? "high",
    confidence: overrides?.confidence ?? 0.9,
    evidenceRefs: [
      {
        evidenceId: parseEvidenceId("ev-001"),
        category: "tool-call-log",
        contentHash: "bond-risk-digest:aaaa1111",
      },
    ],
    detectedAt: "2026-10-01T12:00:00.000Z",
    modelVersion: "test-scorer/v1",
  });
}

export function flagWithStatusForTest(
  flag: RiskFlag,
  status: RiskFlag["status"],
): RiskFlag {
  return { ...flag, status };
}

export function standardProfile(
  id: string,
  organization: string,
): AttestorProfile {
  return {
    attestor: createAttestor({
      attestorId: id,
      organization,
      registeredAt: "2026-09-01T00:00:00.000Z",
    }),
    strictness: 0,
  };
}

export function strictProfile(
  id: string,
  organization: string,
): AttestorProfile {
  return { ...standardProfile(id, organization), strictness: 1 };
}

export function lenientProfile(
  id: string,
  organization: string,
): AttestorProfile {
  return { ...standardProfile(id, organization), strictness: -1 };
}

export function suspendedProfile(
  id: string,
  organization: string,
): AttestorProfile {
  const base = standardProfile(id, organization);
  return {
    ...base,
    attestor: { ...base.attestor, status: "suspended" as const },
  };
}

export const FULL_EVIDENCE = new Set<string>(["ev-001"]);
export const NO_EVIDENCE = new Set<string>([]);
export const NOW = "2026-10-02T00:00:00.000Z";
export const REQUESTED_AT = "2026-10-01T13:00:00.000Z";
export const EXPIRES_AT = "2026-10-08T00:00:00.000Z";
