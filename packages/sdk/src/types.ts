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
  attribution?: ActivityAttribution;
  policy?: {
    allowed: boolean;
    policyVersion: string;
    source: string;
    violations: {
      ruleId: string;
      severity: string;
      category: string;
      reasonCode: string;
      observed: string;
      limit: string;
      explanation: string;
    }[];
  };
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

export interface ReputationEventView {
  eventId: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  impact: number;
  scoreBefore: number;
  scoreAfter: number;
  reasonCode: string;
  reason: string;
  version: string;
  createdAt: string;
}

export interface AgentReputationView {
  agentId: string;
  score: number;
  trustLevel: string;
  version: string;
  updatedAt: string | null;
  events: ReputationEventView[];
}

export interface AgentPolicyInput {
  allowedActions?: readonly string[];
  deniedActions?: readonly string[];
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  allowedProviders?: readonly string[];
  deniedProviders?: readonly string[];
  allowedModels?: readonly string[];
  deniedModels?: readonly string[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxTotalTokensPerWindow?: number;
  tokenWindowSeconds?: number;
  maxRequestsPerWindow?: number;
  requestWindowSeconds?: number;
  maxCostMinorUnitsPerRequest?: string;
  maxCostMinorUnitsPerWindow?: string;
  costWindowSeconds?: number;
  maxTransferMinorUnits?: string;
}

export interface AgentPolicyView {
  policyId: string;
  agentId: string;
  version: number;
  status: string;
  fields: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export interface DelegationScopeView {
  actionTypes: readonly string[] | null;
  tools: readonly string[] | null;
  models: readonly string[] | null;
  providers: readonly string[] | null;
}

export interface DelegationView {
  delegationId: string;
  delegatorAgentId: string;
  delegateAgentId: string;
  capabilities: readonly string[];
  scope: DelegationScopeView;
  status: string;
  version: number;
  protocolVersion: string;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DelegationInput {
  delegateAgentId: string;
  capabilities: readonly string[];
  expiresAt: string;
  scope?: {
    actionTypes?: readonly string[];
    tools?: readonly string[];
    models?: readonly string[];
    providers?: readonly string[];
  };
}

export interface ActivityAttribution {
  requesterAgentId: string;
  executorAgentId: string;
  delegationId: string | null;
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
