/**
 * Agent-scoped client (Phase 18, OFF-CHAIN only).
 *
 * A thin, restricted view over BondClient for callers holding an agent
 * credential: only the four capabilities an agent credential may carry
 * are exposed. Everything else (bonds, transactions, attestations,
 * credential management) stays on BondClient with operator sessions.
 * The credential itself lives in the wrapped client, in memory only.
 */
import { BondClient } from "./client.js";
import type {
  AnalysisResult,
  AgentView,
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

  verifyAgent(id: string): Promise<PublicAgentVerification> {
    return this.client.verifyAgent(id);
  }
}
