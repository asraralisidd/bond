/**
 * Domain enumerations. Terminology follows docs/phase-0 exactly; no
 * competing terms are introduced here.
 */

/** Agent lifecycle states (Phase 0 doc 03 §3.3, ATTESTED resolved out — see agent.ts). */
export type AgentStatus =
  | "UNREGISTERED"
  | "REGISTERED"
  | "BONDED"
  | "ELIGIBLE"
  | "ACTIVE"
  | "FLAGGED"
  | "SLASHED"
  | "SUSPENDED"
  | "RESOLVED"
  | "WITHDRAWABLE";

/** Bond lifecycle states (Phase 0 doc 04 §4.2). */
export type BondStatus =
  | "CREATED"
  | "PENDING"
  | "ACTIVE"
  | "LOCKED"
  | "PARTIALLY_SLASHED"
  | "FULLY_SLASHED"
  | "WITHDRAWABLE"
  | "WITHDRAWN"
  | "FAILED"
  | "CANCELLED";

/** Risk impact (Phase 0 doc 05 §5.2). */
export type RiskSeverity = "low" | "medium" | "high" | "critical";

/** Detection categories (Phase 0 doc 05 §5.2). Extensible by policy. */
export type RiskCategory =
  | "capability-mismatch"
  | "unauthorized-action"
  | "overspend"
  | "data-exfil"
  | "policy-violation"
  | "anomalous-behavior"
  | "external-report";

/** Risk flag lifecycle (Phase 0 doc 05 §5.3). */
export type RiskFlagStatus =
  "open" | "under-review" | "attested" | "dismissed" | "expired";

/** Attestation decision lifecycle (Phase 0 doc 06 §6.3). */
export type AttestationStatus =
  "requested" | "quorum-met" | "decided" | "rejected" | "expired";

/** Per-attestor verdict (Phase 0 doc 06 §6.2). */
export type AttestationVerdict = "confirm" | "reject" | "abstain";

/** Enforcement actions callable via the attested path (Phase 0 doc 06 §6.4). */
export type EnforcementAction = "partial-slash" | "full-slash" | "dismiss";

/** Slash event lifecycle. `initiated` is the off-chain record; `completed`
 * is the confirmed enforcement. */
export type SlashStatus = "initiated" | "completed";

/** Chain-operation states (Phase 0 doc 11 §11.2). Domain only — no wallet. */
export type TransactionStatus =
  "IDLE" | "WALLET_APPROVAL" | "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

/** Purpose of a tracked chain operation. */
export type TransactionPurpose =
  | "FUND_BOND"
  | "RELEASE_BOND"
  | "WITHDRAW"
  | "ENFORCEMENT"
  | "REGISTRATION_ANCHOR";

/** Audit-spine event types (Phase 0 docs 09, 10, 14). */
export type ProtocolEventType =
  | "AGENT_REGISTERED"
  | "BOND_CREATED"
  | "RISK_FLAG_RAISED"
  | "ATTESTATION_ISSUED"
  | "SLASH_INITIATED"
  | "SLASH_COMPLETED"
  | "REPUTATION_UPDATED"
  | "WITHDRAWAL_REQUESTED"
  | "WITHDRAWAL_COMPLETED"
  | "TRANSACTION_STATUS_CHANGED";

/** Evidence descriptor categories (Phase 0 doc 03 §3.2). */
export type EvidenceCategory =
  "transcript" | "tool-call-log" | "transaction-record" | "human-report";

/** Public reputation standing bands (Phase 0 doc 07 §7.4). */
export type ReputationStanding = "good" | "probation" | "poor";

/** Public verification verdicts (Phase 0 doc 12 §12.2). */
export type VerificationResult = "trusted" | "caution" | "untrusted";

/** Coarse agent categories (Phase 0 doc 03 §3.1). Metadata only. */
export type AgentType =
  "conversational" | "coding" | "workflow" | "trading" | "custom";
