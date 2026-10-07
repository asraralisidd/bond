/**
 * Framework-free BOND API client. The single module that talks to the
 * backend: one fetch wrapper, JSON envelope unwrapping, stable error
 * codes with request ids, bearer auth, idempotency keys.
 *
 * No React, no router, no DOM, no storage: the token lives in memory
 * (or a caller-supplied provider) and is never persisted or logged.
 * Transport defaults to global fetch with an injectable override for
 * tests and alternative runtimes. No automatic retries — callers
 * decide, using BondApiError.retryAfter on 429s.
 */
import { BondApiError, parseRetryAfter } from "./errors.js";
import type {
  AgentView,
  AnalysisResult,
  ApiEnvelope,
  ApiErrorBody,
  AttestationView,
  BondView,
  EligibilityProofView,
  EligibilityStatusView,
  HealthView,
  PublicAgentVerification,
  PublicEligibilityView,
  RiskFlagView,
  ReadyView,
  SessionResponse,
  TransactionView,
  WalletChallenge,
  WalletSignature,
} from "./types.js";
import type { BuiltActivity } from "./activity.js";

export type TokenProvider = () =>
  string | null | undefined | Promise<string | null | undefined>;

export type FetchFn = typeof fetch;

/**
 * Resolve the API base URL. Production deployments MUST pass an
 * explicit URL — a silent localhost default in production would point
 * the client at a nonexistent backend. Callers (Vite apps, CLIs) pass
 * their own environment flag; the SDK itself has no opinion about
 * NODE_ENV.
 */
export function resolveApiBase(
  configured: string | undefined,
  isProduction: boolean,
): string {
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  if (isProduction) {
    throw new BondApiError(
      "INVALID_IDENTIFIER",
      "An explicit API base URL is required in production; refusing the localhost default.",
      0,
      null,
    );
  }
  return "http://localhost:4000";
}

export interface BondClientOptions {
  readonly baseUrl: string;
  readonly token?: string | TokenProvider;
  readonly fetchFn?: FetchFn;
  readonly onUnauthorized?: (error: BondApiError) => void;
}

interface RequestOptions {
  readonly idempotent?: boolean;
  readonly skipUnauthorizedHook?: boolean;
  readonly headers?: Record<string, string>;
}

/** Cryptographically random idempotency key (UUID v4 when available). */
export function newIdempotencyKey(): string {
  const cryptoRef =
    typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new BondApiError(
    "UNKNOWN_ERROR",
    "No secure random source available for idempotency keys",
    0,
    null,
  );
}

export class BondClient {
  private readonly baseUrl: string;
  private token: string | TokenProvider | null;
  private readonly fetchFn: FetchFn | null;
  private lastRequestIdValue: string | null = null;
  onUnauthorized: ((error: BondApiError) => void) | null;

  constructor(options: BondClientOptions) {
    if (typeof options.baseUrl !== "string" || options.baseUrl.length === 0) {
      throw new BondApiError(
        "INVALID_IDENTIFIER",
        "BondClient requires a non-empty baseUrl",
        0,
        null,
      );
    }
    this.baseUrl = options.baseUrl;
    this.token = options.token ?? null;
    // Stored, not resolved: global fetch is looked up per request so
    // test doubles installed after construction still take effect.
    this.fetchFn = options.fetchFn ?? null;
    this.onUnauthorized = options.onUnauthorized ?? null;
  }

  /** Replace the in-memory bearer token (never persisted). */
  setToken(token: string | TokenProvider | null): void {
    this.token = token;
  }

  /** Request id of the most recently completed API call (any outcome). */
  get lastRequestId(): string | null {
    return this.lastRequestIdValue;
  }

  private async resolveToken(): Promise<string | null> {
    if (typeof this.token === "function") {
      const value = await this.token();
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    return this.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit & RequestOptions = {},
  ): Promise<{ data: T; requestId: string | null }> {
    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (init.idempotent === true) {
      headers["Idempotency-Key"] = newIdempotencyKey();
    }
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new BondApiError(
        "UNKNOWN_ERROR",
        "No global fetch available; pass fetchFn explicitly",
        0,
        null,
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new BondApiError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Network unreachable",
        0,
        null,
      );
    }
    const requestId = res.headers.get("x-request-id");
    this.lastRequestIdValue = requestId;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body — handled below via status
    }
    if (!res.ok) {
      const err = body as Partial<ApiErrorBody> | null;
      const apiError = new BondApiError(
        typeof err?.code === "string" ? err.code : "UNKNOWN_ERROR",
        typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
        res.status,
        requestId,
        res.status === 429
          ? parseRetryAfter(res.headers.get("retry-after"))
          : null,
      );
      if (res.status === 401 && !init.skipUnauthorizedHook) {
        try {
          this.onUnauthorized?.(apiError);
        } catch {
          // handler must never break the error path
        }
      }
      throw apiError;
    }
    return { data: (body as ApiEnvelope<T>).data, requestId };
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" }).then((r) => r.data);
  }

  private post<T>(
    path: string,
    body?: unknown,
    idempotent = false,
    skipUnauthorizedHook = false,
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      idempotent,
      skipUnauthorizedHook,
    }).then((r) => r.data);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.data);
  }

  health(): Promise<HealthView> {
    return this.get<HealthView>("/health");
  }

  ready(): Promise<ReadyView> {
    return this.request<ReadyView>("/ready", { method: "GET" }).then(
      (r) => r.data,
    );
  }

  createSession(devKey: string, externalKey: string): Promise<SessionResponse> {
    return this.post<SessionResponse>("/api/v1/auth/session", {
      devKey,
      externalKey,
    });
  }

  signOut(): Promise<{ signedOut: boolean }> {
    return this.post<{ signedOut: boolean }>(
      "/api/v1/auth/sign-out",
      {},
      false,
      true,
    );
  }

  requestWalletChallenge(network?: string): Promise<WalletChallenge> {
    return this.post<WalletChallenge>("/api/v1/auth/wallet/challenge", {
      network,
    });
  }

  verifyWalletChallenge(
    challengeId: string,
    signature: WalletSignature,
  ): Promise<SessionResponse> {
    return this.post<SessionResponse>("/api/v1/auth/wallet/verify", {
      challengeId,
      signature,
    });
  }

  listAgents(limit = 50): Promise<AgentView[]> {
    return this.get<AgentView[]>(`/api/v1/agents?limit=${limit}`);
  }

  getAgent(id: string): Promise<AgentView> {
    return this.get<AgentView>(`/api/v1/agents/${id}`);
  }

  registerAgent(input: {
    platform: string;
    agentType: string;
    capabilities: string[];
    externalRef: string;
  }): Promise<AgentView> {
    return this.post<AgentView>("/api/v1/agents", input, true);
  }

  setAgentStatus(id: string, status: string): Promise<AgentView> {
    return this.patch<AgentView>(`/api/v1/agents/${id}/status`, { status });
  }

  createBond(input: {
    agentId: string;
    commitmentMinorUnits: string;
  }): Promise<BondView> {
    return this.post<BondView>("/api/v1/bonds", input, true);
  }

  getBond(id: string): Promise<BondView> {
    return this.get<BondView>(`/api/v1/bonds/${id}`);
  }

  setBondStatus(id: string, status: string): Promise<BondView> {
    return this.patch<BondView>(`/api/v1/bonds/${id}/status`, { status });
  }

  createTransaction(input: {
    purpose: string;
    agentId?: string;
    bondId?: string;
    idempotencyKey: string;
    nullifier?: string;
  }): Promise<TransactionView> {
    return this.post<TransactionView>("/api/v1/transactions", input, false);
  }

  getTransaction(id: string): Promise<TransactionView> {
    return this.get<TransactionView>(`/api/v1/transactions/${id}`);
  }

  advanceTransaction(id: string, status: string): Promise<TransactionView> {
    return this.post<TransactionView>(`/api/v1/transactions/${id}/advance`, {
      status,
    });
  }

  recordWalletSubmission(
    id: string,
    chainTxId: string,
  ): Promise<TransactionView> {
    return this.post<TransactionView>(`/api/v1/transactions/${id}/submitted`, {
      chainTxId,
    });
  }

  confirmTransaction(id: string): Promise<TransactionView> {
    return this.post<TransactionView>(`/api/v1/transactions/${id}/confirm`, {});
  }

  analyzeActivity(
    agentId: string,
    activity: Record<string, unknown> | BuiltActivity,
  ): Promise<AnalysisResult> {
    return this.post<AnalysisResult>(
      "/api/v1/risk/analyses",
      { agentId, activity },
      true,
    );
  }

  listFlags(agentId: string): Promise<RiskFlagView[]> {
    return this.get<RiskFlagView[]>(
      `/api/v1/risk/flags?agentId=${encodeURIComponent(agentId)}`,
    );
  }

  getFlag(id: string): Promise<RiskFlagView> {
    return this.get<RiskFlagView>(`/api/v1/risk/flags/${id}`);
  }

  registerAttestor(input: {
    attestorId?: string;
    organization: string;
    secret: string;
  }): Promise<{ attestorId: string }> {
    return this.post<{ attestorId: string }>("/api/v1/attestors", input);
  }

  requestAttestation(input: {
    flagId: string;
    attestorIds: string[];
    threshold?: number;
    expiresAt: string;
    idempotencyKey?: string;
  }): Promise<{ attestationId: string; status: string }> {
    return this.post<{ attestationId: string; status: string }>(
      "/api/v1/attestations",
      {
        ...input,
        idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(),
      },
      false,
    );
  }

  getAttestation(id: string): Promise<AttestationView> {
    return this.get<AttestationView>(`/api/v1/attestations/${id}`);
  }

  async submitVerdict(
    id: string,
    input: { attestorId: string; verdict: string; secret: string },
  ): Promise<{ status: string; verdicts: number }> {
    // Attestor-secret auth (NOT the bearer token): the secret travels in
    // a header to this endpoint only, never in logs or elsewhere.
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new BondApiError(
        "UNKNOWN_ERROR",
        "No global fetch available; pass fetchFn explicitly",
        0,
        null,
      );
    }
    const res = await fetchImpl(
      `${this.baseUrl}/api/v1/attestations/${id}/verdicts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Attestor-Secret": input.secret,
        },
        body: JSON.stringify({
          attestorId: input.attestorId,
          verdict: input.verdict,
        }),
      },
    );
    this.lastRequestIdValue = res.headers.get("x-request-id");
    if (!res.ok) {
      const err = (await res
        .json()
        .catch(() => null)) as Partial<ApiErrorBody> | null;
      throw new BondApiError(
        typeof err?.code === "string" ? err.code : "UNKNOWN_ERROR",
        typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
        res.status,
        res.headers.get("x-request-id"),
        res.status === 429
          ? parseRetryAfter(res.headers.get("retry-after"))
          : null,
      );
    }
    return (await res.json()).data as { status: string; verdicts: number };
  }

  evaluateAttestation(
    id: string,
    strictness?: number,
  ): Promise<{ status: string; evaluations: string[] }> {
    return this.post<{ status: string; evaluations: string[] }>(
      `/api/v1/attestations/${id}/evaluate`,
      { strictness },
    );
  }

  issueDecision(
    id: string,
    action?: string,
  ): Promise<{ status: string; action: string | null }> {
    return this.post<{ status: string; action: string | null }>(
      `/api/v1/attestations/${id}/decision`,
      { action },
    );
  }

  enforceAttestation(
    id: string,
    amountMinorUnits?: string,
  ): Promise<{ transactionId: string; purpose: string; status: string }> {
    return this.post<{
      transactionId: string;
      purpose: string;
      status: string;
    }>(
      `/api/v1/attestations/${id}/enforce`,
      { amountMinorUnits, idempotencyKey: newIdempotencyKey() },
      false,
    );
  }

  createEligibilityProof(input: {
    agentId: string;
    bondId: string;
    policyVersion?: string;
    purpose?: string;
    requiredMinimumMinorUnits: string;
    nonce: string;
    expiresAt: string;
  }): Promise<EligibilityProofView> {
    return this.post<EligibilityProofView>(
      "/api/v1/eligibility/proofs",
      input,
      true,
    );
  }

  getEligibility(id: string): Promise<EligibilityStatusView> {
    return this.get<EligibilityStatusView>(`/api/v1/eligibility/proofs/${id}`);
  }

  consumeEligibility(id: string, nonce: string): Promise<{ status: string }> {
    return this.post<{ status: string }>(
      `/api/v1/eligibility/proofs/${id}/consume`,
      { nonce },
    );
  }

  verifyAgent(id: string): Promise<PublicAgentVerification> {
    return this.get<PublicAgentVerification>(
      `/api/v1/public/agents/${encodeURIComponent(id)}`,
    );
  }

  verifyEligibility(
    id: string,
    policyVersion?: string,
  ): Promise<PublicEligibilityView> {
    return this.get<PublicEligibilityView>(
      `/api/v1/public/agents/${encodeURIComponent(id)}/eligibility${
        policyVersion
          ? `?policyVersion=${encodeURIComponent(policyVersion)}`
          : ""
      }`,
    );
  }
}
