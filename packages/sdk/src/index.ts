/**
 * @bond/sdk — framework-free BOND API client for external AI agents.
 *
 * No React, no router, no DOM, no storage. The token lives in memory
 * (or a caller-supplied provider) and is never persisted or logged.
 */
export { BondApiError, friendlyMessage, parseRetryAfter } from "./errors.js";
export type { TokenProvider, FetchFn, BondClientOptions } from "./client.js";
export { BondClient, newIdempotencyKey, resolveApiBase } from "./client.js";
export { BondAgentClient } from "./agent.js";
export type {
  AgentCredentialMetadata,
  AgentCredentialSecret,
} from "./agent.js";
export type {
  ActivityType,
  ReporterSeverity,
  ActivityPolicyContext,
  ActivityInput,
  BuiltActivity,
} from "./activity.js";
export { ACTIVITY_TYPES, buildActivity } from "./activity.js";
export type { RedactedMetadata } from "./redact.js";
export { isSecretLikeKey, redactMetadata, truncateSnippet } from "./redact.js";
export type {
  ApiEnvelope,
  ApiErrorBody,
  SessionResponse,
  WalletChallenge,
  WalletSignature,
  AgentView,
  BondView,
  RiskScoreView,
  AnalysisResult,
  RiskFlagView,
  AttestationView,
  TransactionView,
  EligibilityProofView,
  EligibilityStatusView,
  PublicVerificationView,
  PublicAgentVerification,
  PublicEligibilityView,
  HealthView,
  ReadyView,
} from "./types.js";
