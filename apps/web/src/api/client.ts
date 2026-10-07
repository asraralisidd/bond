/**
 * Web API surface — thin compatibility layer over @bond/sdk.
 *
 * All reusable transport, error, and idempotency logic lives in the
 * framework-free SDK. This module only wires the SDK to browser
 * concerns: localStorage-backed tokens, Vite base URL, the React
 * data-fetch hook, and the session-expired handler.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BondClient, friendlyMessage } from "@bond/sdk";
import { BondApiError as ApiError } from "@bond/sdk";
import type { BondApiError as SdkApiError } from "@bond/sdk";

export { ApiError, friendlyMessage };

const TOKEN_KEY = "bond.session.token";

/**
 * Resolve the API base URL. Production builds MUST set VITE_API_URL
 * explicitly — a silent localhost default in a production bundle would
 * point the app at a nonexistent backend. Development keeps the
 * convenient localhost default.
 */
export function resolveApiBase(
  configured: string | undefined,
  isProduction: boolean,
): string {
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  if (isProduction) {
    throw new Error(
      "VITE_API_URL must be set for production builds; refusing the localhost default.",
    );
  }
  return "http://localhost:4000";
}

export function getApiBase(): string {
  return resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.PROD);
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

/** Shared client wired to browser token storage. */
const defaultClient = new BondClient({
  baseUrl: getApiBase(),
  token: () => getToken(),
});

/** Request id of the most recently completed API call (any outcome). */
export function getLastRequestId(): string | null {
  return defaultClient.lastRequestId;
}

/**
 * Registers the session-expired handler (wired once by SessionProvider).
 * Fires on any 401 so stale tokens clear immediately and the UI
 * returns to login with a safe message.
 */
export function setUnauthorizedHandler(
  handler: ((error: SdkApiError) => void) | null,
): void {
  defaultClient.onUnauthorized = handler;
}

export const api = {
  health: () => defaultClient.health(),
  ready: () => defaultClient.ready(),
  createSession: (devKey: string, externalKey: string) =>
    defaultClient.createSession(devKey, externalKey),
  signOut: () => defaultClient.signOut(),
  requestWalletChallenge: (network?: string) =>
    defaultClient.requestWalletChallenge(network),
  verifyWalletChallenge: (
    challengeId: string,
    signature: { data: string; signature: string; verifyingKey: string },
  ) => defaultClient.verifyWalletChallenge(challengeId, signature),

  listAgents: (limit = 50) => defaultClient.listAgents(limit),
  getAgent: (id: string) => defaultClient.getAgent(id),
  registerAgent: (input: {
    platform: string;
    agentType: string;
    capabilities: string[];
    externalRef: string;
  }) => defaultClient.registerAgent(input),
  setAgentStatus: (id: string, status: string) =>
    defaultClient.setAgentStatus(id, status),

  createBond: (input: { agentId: string; commitmentMinorUnits: string }) =>
    defaultClient.createBond(input),
  getBond: (id: string) => defaultClient.getBond(id),
  setBondStatus: (id: string, status: string) =>
    defaultClient.setBondStatus(id, status),

  createTransaction: (input: {
    purpose: string;
    agentId?: string;
    bondId?: string;
    idempotencyKey: string;
    nullifier?: string;
  }) => defaultClient.createTransaction(input),
  getTransaction: (id: string) => defaultClient.getTransaction(id),
  advanceTransaction: (id: string, status: string) =>
    defaultClient.advanceTransaction(id, status),
  recordWalletSubmission: (id: string, chainTxId: string) =>
    defaultClient.recordWalletSubmission(id, chainTxId),
  confirmTransaction: (id: string) => defaultClient.confirmTransaction(id),

  analyzeActivity: (agentId: string, activity: Record<string, unknown>) =>
    defaultClient.analyzeActivity(agentId, activity),
  listFlags: (agentId: string) => defaultClient.listFlags(agentId),
  getFlag: (id: string) => defaultClient.getFlag(id),

  registerAttestor: (input: {
    attestorId?: string;
    organization: string;
    secret: string;
  }) => defaultClient.registerAttestor(input),
  requestAttestation: (input: {
    flagId: string;
    attestorIds: string[];
    threshold?: number;
    expiresAt: string;
    idempotencyKey?: string;
  }) => defaultClient.requestAttestation(input),
  getAttestation: (id: string) => defaultClient.getAttestation(id),
  submitVerdict: (
    id: string,
    input: { attestorId: string; verdict: string; secret: string },
  ) => defaultClient.submitVerdict(id, input),
  evaluateAttestation: (id: string, strictness?: number) =>
    defaultClient.evaluateAttestation(id, strictness),
  issueDecision: (id: string, action?: string) =>
    defaultClient.issueDecision(id, action),
  enforceAttestation: (id: string, amountMinorUnits?: string) =>
    defaultClient.enforceAttestation(id, amountMinorUnits),

  createEligibilityProof: (input: {
    agentId: string;
    bondId: string;
    policyVersion?: string;
    purpose?: string;
    requiredMinimumMinorUnits: string;
    nonce: string;
    expiresAt: string;
  }) => defaultClient.createEligibilityProof(input),
  getEligibility: (id: string) => defaultClient.getEligibility(id),
  consumeEligibility: (id: string, nonce: string) =>
    defaultClient.consumeEligibility(id, nonce),

  verifyAgent: (id: string) => defaultClient.verifyAgent(id),
  verifyEligibility: (id: string, policyVersion?: string) =>
    defaultClient.verifyEligibility(id, policyVersion),
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
          setRequestId(defaultClient.lastRequestId);
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
          setRequestId(apiError.requestId ?? defaultClient.lastRequestId);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, ...deps]);

  return { data, error, loading, requestId, reload };
}
