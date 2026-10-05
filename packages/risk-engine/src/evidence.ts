/**
 * Engine-side evidence representation.
 *
 * EvidenceRefs handed to RiskFlags carry digests/pointers only — never raw
 * content. The digest here is a NON-CRYPTOGRAPHIC fingerprint (FNV-1a over
 * canonical JSON), used solely for deterministic derivation and
 * deduplication. It is NOT an integrity proof; attestation-grade integrity
 * hashing is a Phase 3+/infrastructure concern and must not be confused
 * with this. Documented as such wherever the digest surfaces.
 */
import { parseEvidenceId } from "@bond/shared-types";
import type { EvidenceRef } from "@bond/shared-types";
import type { NormalizedActivity } from "./input.js";

/** Canonical JSON: sorted keys, stable for identical input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * FNV-1a 32-bit fingerprint, hex-encoded. Deterministic across runs and
 * platforms for identical input. NOT cryptographic — dedup/derivation only.
 */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable activity key for dedup and deterministic ID derivation. */
export function activityKey(activity: NormalizedActivity): string {
  return fingerprint(
    canonicalJson({
      activityId: activity.activityId,
      agentId: activity.agentId,
      occurredAt: activity.occurredAt,
      actionType: activity.actionType,
      action: activity.action,
      tool: activity.tool,
      amountMinorUnits: activity.amountMinorUnits,
      externalDestination: activity.externalDestination,
      bytesOut: activity.bytesOut,
      textSnippet: activity.textSnippet,
      metadata: activity.metadata,
    }),
  );
}

export interface EngineEvidence {
  readonly evidenceId: string;
  readonly category:
    "tool-call-log" | "transaction-record" | "human-report" | "transcript";
  /** Non-cryptographic digest (see module doc). Opaque downstream. */
  readonly digest: string;
}

const EVIDENCE_CATEGORY_BY_ACTION_TYPE: Record<
  string,
  EngineEvidence["category"]
> = {
  "tool-call": "tool-call-log",
  transfer: "transaction-record",
  message: "transcript",
  "policy-decision": "tool-call-log",
  auth: "tool-call-log",
  "config-change": "tool-call-log",
  "external-report": "human-report",
};

/** Derives one evidence descriptor per analyzed activity (deterministic). */
export function deriveEvidence(activity: NormalizedActivity): EngineEvidence {
  const digest = activityKey(activity);
  return {
    evidenceId: `ev-${digest}`,
    category: EVIDENCE_CATEGORY_BY_ACTION_TYPE[activity.actionType],
    digest,
  };
}

/** Converts engine evidence to the shared domain EvidenceRef. */
export function toEvidenceRef(evidence: EngineEvidence): EvidenceRef {
  return {
    evidenceId: parseEvidenceId(evidence.evidenceId),
    category: evidence.category,
    contentHash: `bond-risk-digest:${evidence.digest}`,
  };
}
