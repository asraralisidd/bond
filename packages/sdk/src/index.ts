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
  SetupGrantMetadata,
  SetupGrantSecret,
} from "./agent.js";
export type {
  ActivityType,
  ReporterSeverity,
  ActivityPolicyContext,
  ActivityInput,
  BuiltActivity,
} from "./activity.js";
export {
  ACTIVITY_TYPES,
  buildActivity,
  buildModelActivity,
} from "./activity.js";
export type { ModelActivityUsage } from "./activity.js";
export {
  normalizeUsage,
  normalizeOpenAIUsage,
  normalizeAnthropicUsage,
  normalizeGeminiUsage,
  normalizeDeepSeekUsage,
  normalizeLocalUsage,
} from "./providers/index.js";
export type {
  NormalizedModelUsage,
  NormalizeUsageOptions,
} from "./providers/index.js";
export { describeFrameworkEvent } from "./adapters/generic.js";
export type {
  DescribedFrameworkEvent,
  FrameworkAdapterConfig,
} from "./adapters/generic.js";
export type { RedactedMetadata } from "./redact.js";
export { isSecretLikeKey, redactMetadata, truncateSnippet } from "./redact.js";
export type {
  ApiEnvelope,
  ApiErrorBody,
  SessionResponse,
  WalletChallenge,
  WalletSignature,
  AgentView,
  AgentReputationView,
  AgentPolicyInput,
  AgentPolicyView,
  DelegationScopeView,
  DelegationView,
  DelegationInput,
  ActivityAttribution,
  BondView,
  RiskScoreView,
  AnalysisResult,
  RiskFlagView,
  ReputationEventView,
  AttestationView,
  TransactionView,
  EligibilityProofView,
  EligibilityStatusView,
  PublicVerificationView,
  PublicAgentVerification,
  PublicEligibilityView,
  HealthView,
  ReadyView,
  EventFeedItem,
  EventFeedPage,
} from "./types.js";
