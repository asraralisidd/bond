/**
 * Backend DTO mirrors for SDK consumers. These types describe exactly
 * what the API returns — no more. The SDK never invents fields;
 * anything the API does not send cannot be consumed.
 */

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string | null;
}

export interface SessionResponse {
  token: string;
  operatorId: string;
  sessionId: string;
}

export interface WalletChallenge {
  challengeId: string;
  nonce: string;
  network: string;
  message: string;
  expiresAt: string;
}

export interface WalletSignature {
  data: string;
  signature: string;
  verifyingKey: string;
}

export interface AgentView {
  agentId: string;
  platform: string;
  agentType: string;
  capabilities: readonly string[];
  externalRef: string;
  status: string;
  policyVersion: string;
  syncStatus: string;
}

export interface BondView {
  bondId: string;
  agentId: string;
  status: string;
  policyVersion: string;
  slashedTotalMinorUnits: string;
  chainTxId: string | null;
  withdrawalConsumed: boolean;
}

export interface RiskScoreView {
  score: number | null;
  severity: string | null;
  confidence: number | null;
  factors: unknown;
}

export interface AnalysisResult {
  analysisId: string;
  flagIds: string[];
  score: RiskScoreView | null;
}

export interface RiskFlagView {
  riskFlagId: string;
  category: string;
  severity: string;
  confidence: number;
  evidenceIds: string[];
  modelVersion: string;
  status: string;
}

export interface AttestationView {
  attestationId: string;
  flagId: string;
  agentId: string;
  threshold: number;
  policyVersion: string;
  verdicts: {
    attestorId: string;
    verdict: "confirm" | "reject" | "abstain";
    issuedAt: string;
  }[];
  status: string;
  decision: {
    decisionId: string;
    action: string;
    nullifier: string;
    expiresAt: string;
  } | null;
  requestedAt: string;
  expiresAt: string;
}

export interface TransactionView {
  transactionId: string;
  purpose: string;
  agentId?: string | null;
  bondId?: string | null;
  status: string;
  chainTxId?: string | null;
  confirmedAt?: string | null;
}

export interface EligibilityProofView {
  proofId: string;
  status: string;
}

export interface EligibilityStatusView {
  agentId: string;
  eligible: boolean;
  reason: string;
  policyVersion: string;
  purpose: string;
  proofStatus: string;
  asOf: string;
}

export interface PublicVerificationView {
  agentId: string;
  result: "trusted" | "caution" | "untrusted";
  policyVersion: string;
  rulesVersion: string;
  registrationStatus: string;
  bondStatus: string | null;
  reputationStanding: string;
  slashCount: number;
  asOf: string;
}

export interface PublicAgentVerification {
  verification: PublicVerificationView;
  bond: { status: string } | null;
  reputation: {
    standing: string;
    confirmedFlags: number;
    partialSlashes: number;
    fullSlashes: number;
    resolvedWithRemediation: number;
  } | null;
  slashHistory: {
    slashEventId: string;
    band: "partial" | "full";
    severity: string;
    completedAt: string | null;
  }[];
}

export interface PublicEligibilityView {
  agentId: string;
  policyVersion: string;
  eligible: boolean;
  proofs: { proofId: string; purpose: string; status: string }[];
  asOf: string;
}

export interface HealthView {
  status: string;
  version: string;
  service: string;
}

export interface ReadyView {
  ready: boolean;
  checks: {
    database: { ok: boolean; schema: boolean };
    midnight: { mode: string; network: string | null };
    worker: {
      enabled: boolean;
      phase: string;
      running: boolean;
      draining: boolean;
      lastPollAt: string | null;
      activeJobs: number;
      lastError: string | null;
    } | null;
  };
}

export interface EventFeedItem {
  id: string;
  type: string;
  agentId: string | null;
  bondId: string | null;
  txId: string | null;
  actor: string;
  policyVersion: string | null;
  requestId: string | null;
  createdAt: string;
  payload: unknown;
}

export interface EventFeedPage {
  events: EventFeedItem[];
  nextCursor: string | null;
}
