/**
 * Central typed API client — the ONLY module that talks to the backend.
 *
 * - single fetch wrapper, JSON envelope unwrapping
 * - ApiError with stable backend codes + request ids
 * - session token from storage, sent as Bearer
 * - Idempotency-Key sender for mutations
 * - no duplicated fetch logic in components (useApi hook below)
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId: string | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * User-facing message for API failures. Rate limiting gets a calm,
 * actionable message with no automatic retry — the caller retries
 * explicitly (existing Retry buttons), so a 429 never triggers a
 * client-side retry storm.
 */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "RATE_LIMITED") {
    return "Too many requests — please wait a moment and try again.";
  }
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const TOKEN_KEY = "bond.session.token";

export function getApiBase(): string {
  return import.meta.env.VITE_API_URL ?? "http://localhost:4000";
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) {
      window.localStorage.removeItem(TOKEN_KEY);
    } else {
      window.localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    // storage unavailable (private mode) — session simply won't persist
  }
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let lastRequestId: string | null = null;

/** Request id of the most recently completed API call (any outcome). */
export function getLastRequestId(): string | null {
  return lastRequestId;
}

async function request<T>(
  path: string,
  init: RequestInit & {
    idempotent?: boolean;
    skipUnauthorizedHook?: boolean;
  } = {},
): Promise<{ data: T; requestId: string | null }> {
  const token = getToken();
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
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : "Network unreachable",
      0,
      null,
    );
  }
  const requestId = res.headers.get("x-request-id");
  lastRequestId = requestId;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body — handled below via status
  }
  if (!res.ok) {
    const err = body as Partial<ApiErrorBody> | null;
    const apiError = new ApiError(
      typeof err?.code === "string" ? err.code : "UNKNOWN_ERROR",
      typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
      res.status,
      requestId,
    );
    if (res.status === 401 && !init.skipUnauthorizedHook) {
      notifyUnauthorized(apiError);
    }
    throw apiError;
  }
  return { data: (body as ApiEnvelope<T>).data, requestId };
}

type UnauthorizedHandler = (error: ApiError) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registers the session-expired handler (wired once by SessionProvider).
 * Fires on any 401 so stale tokens clear immediately and the UI
 * returns to login with a safe message.
 */
export function setUnauthorizedHandler(
  handler: UnauthorizedHandler | null,
): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(error: ApiError): void {
  try {
    unauthorizedHandler?.(error);
  } catch {
    // handler must never break the error path
  }
}

const get = <T>(path: string) =>
  request<T>(path, { method: "GET" }).then((r) => r.data);

function post<T>(
  path: string,
  body?: unknown,
  idempotent = false,
  skipUnauthorizedHook = false,
) {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    idempotent,
    skipUnauthorizedHook,
  }).then((r) => r.data);
}

function patch<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.data);
}

export const api = {
  health: () => get<HealthView>("/health"),
  ready: () =>
    request<ReadyView>("/ready", { method: "GET" }).then((r) => r.data),
  createSession: (devKey: string, externalKey: string) =>
    post<SessionResponse>("/api/v1/auth/session", { devKey, externalKey }),
  signOut: () =>
    post<{ signedOut: boolean }>("/api/v1/auth/sign-out", {}, false, true),
  requestWalletChallenge: (network?: string) =>
    post<WalletChallenge>("/api/v1/auth/wallet/challenge", { network }),
  verifyWalletChallenge: (challengeId: string, signature: WalletSignature) =>
    post<SessionResponse>("/api/v1/auth/wallet/verify", {
      challengeId,
      signature,
    }),

  listAgents: (limit = 50) => get<AgentView[]>(`/api/v1/agents?limit=${limit}`),
  getAgent: (id: string) => get<AgentView>(`/api/v1/agents/${id}`),
  registerAgent: (input: {
    platform: string;
    agentType: string;
    capabilities: string[];
    externalRef: string;
  }) => post<AgentView>("/api/v1/agents", input, true),
  setAgentStatus: (id: string, status: string) =>
    patch<AgentView>(`/api/v1/agents/${id}/status`, { status }),

  createBond: (input: { agentId: string; commitmentMinorUnits: string }) =>
    post<BondView>("/api/v1/bonds", input, true),
  getBond: (id: string) => get<BondView>(`/api/v1/bonds/${id}`),
  setBondStatus: (id: string, status: string) =>
    patch<BondView>(`/api/v1/bonds/${id}/status`, { status }),

  createTransaction: (input: {
    purpose: string;
    agentId?: string;
    bondId?: string;
    idempotencyKey: string;
    nullifier?: string;
  }) => post<TransactionView>("/api/v1/transactions", input, false),
  getTransaction: (id: string) =>
    get<TransactionView>(`/api/v1/transactions/${id}`),
  advanceTransaction: (id: string, status: string) =>
    post<TransactionView>(`/api/v1/transactions/${id}/advance`, { status }),
  recordWalletSubmission: (id: string, chainTxId: string) =>
    post<TransactionView>(`/api/v1/transactions/${id}/submitted`, {
      chainTxId,
    }),
  confirmTransaction: (id: string) =>
    post<TransactionView>(`/api/v1/transactions/${id}/confirm`, {}),

  analyzeActivity: (agentId: string, activity: Record<string, unknown>) =>
    post<AnalysisResult>("/api/v1/risk/analyses", { agentId, activity }, true),
  listFlags: (agentId: string) =>
    get<RiskFlagView[]>(
      `/api/v1/risk/flags?agentId=${encodeURIComponent(agentId)}`,
    ),
  getFlag: (id: string) => get<RiskFlagView>(`/api/v1/risk/flags/${id}`),

  registerAttestor: (input: {
    attestorId?: string;
    organization: string;
    secret: string;
  }) => post<{ attestorId: string }>("/api/v1/attestors", input),
  requestAttestation: (input: {
    flagId: string;
    attestorIds: string[];
    threshold?: number;
    expiresAt: string;
    idempotencyKey?: string;
  }) =>
    post<{ attestationId: string; status: string }>(
      "/api/v1/attestations",
      { ...input, idempotencyKey: input.idempotencyKey ?? newIdempotencyKey() },
      false,
    ),
  getAttestation: (id: string) =>
    get<AttestationView>(`/api/v1/attestations/${id}`),
  submitVerdict: (
    id: string,
    input: { attestorId: string; verdict: string; secret: string },
  ) =>
    fetch(`${getApiBase()}/api/v1/attestations/${id}/verdicts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Attestor-Secret": input.secret,
      },
      body: JSON.stringify({
        attestorId: input.attestorId,
        verdict: input.verdict,
      }),
    }).then(async (res) => {
      lastRequestId = res.headers.get("x-request-id");
      if (!res.ok) {
        const err = (await res
          .json()
          .catch(() => null)) as Partial<ApiErrorBody> | null;
        throw new ApiError(
          typeof err?.code === "string" ? err.code : "UNKNOWN_ERROR",
          typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
          res.status,
          res.headers.get("x-request-id"),
        );
      }
      return (await res.json()).data as { status: string; verdicts: number };
    }),
  evaluateAttestation: (id: string, strictness?: number) =>
    post<{ status: string; evaluations: string[] }>(
      `/api/v1/attestations/${id}/evaluate`,
      { strictness },
    ),
  issueDecision: (id: string, action?: string) =>
    post<{ status: string; action: string | null }>(
      `/api/v1/attestations/${id}/decision`,
      { action },
    ),
  enforceAttestation: (id: string, amountMinorUnits?: string) =>
    post<{ transactionId: string; purpose: string; status: string }>(
      `/api/v1/attestations/${id}/enforce`,
      { amountMinorUnits, idempotencyKey: newIdempotencyKey() },
      false,
    ),

  createEligibilityProof: (input: {
    agentId: string;
    bondId: string;
    policyVersion?: string;
    purpose?: string;
    requiredMinimumMinorUnits: string;
    nonce: string;
    expiresAt: string;
  }) => post<EligibilityProofView>("/api/v1/eligibility/proofs", input, true),
  getEligibility: (id: string) =>
    get<EligibilityStatusView>(`/api/v1/eligibility/proofs/${id}`),
  consumeEligibility: (id: string, nonce: string) =>
    post<{ status: string }>(`/api/v1/eligibility/proofs/${id}/consume`, {
      nonce,
    }),

  verifyAgent: (id: string) =>
    get<PublicAgentVerification>(
      `/api/v1/public/agents/${encodeURIComponent(id)}`,
    ),
  verifyEligibility: (id: string, policyVersion?: string) =>
    get<PublicEligibilityView>(
      `/api/v1/public/agents/${encodeURIComponent(id)}/eligibility${
        policyVersion
          ? `?policyVersion=${encodeURIComponent(policyVersion)}`
          : ""
      }`,
    ),
};

export interface UseApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  requestId: string | null;
  reload: () => void;
}

/** Data-fetch hook with loading/error/empty semantics + request ids. */
export function useApi<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setRequestId(getLastRequestId());
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const apiError =
            e instanceof ApiError
              ? e
              : new ApiError("UNKNOWN_ERROR", String(e), 0, null);
          setError(apiError);
          setRequestId(apiError.requestId ?? getLastRequestId());
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, ...deps]);

  return { data, error, loading, requestId, reload };
}
