/**
 * Agent-scoped client (Phase 18, OFF-CHAIN only).
 *
 * A thin, restricted view over BondClient for callers holding an agent
 * credential: only the five capabilities an agent credential may carry
 * are exposed. Everything else (bonds, transactions, attestations,
 * credential management) stays on BondClient with operator sessions.
 * The credential itself lives in the wrapped client, in memory only.
 */
import { BondClient } from "./client.js";
import type {
  AgentReputationView,
  AgentPolicyView,
  AnalysisResult,
  AgentView,
  EventFeedPage,
  PublicAgentVerification,
  RiskFlagView,
} from "./types.js";
import type { BuiltActivity } from "./activity.js";

export interface AgentCredentialMetadata {
  readonly credentialId: string;
  readonly agentId: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
}

export interface AgentCredentialSecret {
  /** Raw secret: present ONLY in create/rotate responses. */
  readonly metadata: AgentCredentialMetadata;
  readonly secret: string;
}

export interface SetupGrantMetadata {
  readonly grantId: string;
  readonly operatorId: string;
  readonly agentId: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
}

export interface SetupGrantSecret {
  /** Raw secret: present ONLY in the create response. */
  readonly metadata: SetupGrantMetadata;
  readonly secret: string;
}

export class BondAgentClient {
  private readonly client: BondClient;

  /**
   * Wrap an existing BondClient configured with an agent credential
   * (e.g. `new BondClient({ baseUrl, token: "<credentialId>.<secret>" })`).
   */
  constructor(client: BondClient) {
    this.client = client;
  }

  /** Replace the in-memory agent credential (never persisted). */
  setToken(token: string | null): void {
    this.client.setToken(token);
  }

  get lastRequestId(): string | null {
    return this.client.lastRequestId;
  }

  analyzeActivity(
    agentId: string,
    activity: Record<string, unknown> | BuiltActivity,
  ): Promise<AnalysisResult> {
    return this.client.analyzeActivity(agentId, activity);
  }

  listFlags(agentId: string): Promise<RiskFlagView[]> {
    return this.client.listFlags(agentId);
  }

  getFlag(id: string): Promise<RiskFlagView> {
    return this.client.getFlag(id);
  }

  getAgent(id: string): Promise<AgentView> {
    return this.client.getAgent(id);
  }

  /** Read the caller's own reputation (server enforces self-access). */
  getReputation(id: string, limit = 20): Promise<AgentReputationView> {
    return this.client.getAgentReputation(id, limit);
  }

  /** Read the caller's own effective policy (no mutation surface). */
  getPolicy(id: string): Promise<AgentPolicyView> {
    return this.client.getAgentPolicy(id);
  }

  listEvents(input?: {
    limit?: number;
    cursor?: string;
    type?: string;
  }): Promise<EventFeedPage> {
    return this.client.listEvents(input);
  }

  verifyAgent(id: string): Promise<PublicAgentVerification> {
    return this.client.verifyAgent(id);
  }
}
