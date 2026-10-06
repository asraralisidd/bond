/**
 * Session state: token in localStorage, operator id alongside it.
 * Wallet identity alongside it (verifying key + network, public only).
 * No global store library — one context is sufficient.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  api,
  getToken,
  setToken,
  setUnauthorizedHandler,
} from "../api/client.js";

const OPERATOR_KEY = "bond.session.operator";
const EXPIRED_FLAG = "bond.session.expired";
const WALLET_KEY = "bond.session.wallet.vk";
const WALLET_NETWORK_KEY = "bond.session.wallet.network";

function getStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function getOperator(): string | null {
  try {
    return window.localStorage.getItem(OPERATOR_KEY);
  } catch {
    return null;
  }
}

/** Set when a 401 cleared the session; LoginPage shows the notice once. */
export function consumeExpiredNotice(): boolean {
  try {
    if (window.sessionStorage.getItem(EXPIRED_FLAG) === "1") {
      window.sessionStorage.removeItem(EXPIRED_FLAG);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

interface Session {
  token: string | null;
  operatorId: string | null;
  walletVerifyingKey: string | null;
  walletNetwork: string | null;
  signIn: (devKey: string, externalKey: string) => Promise<void>;
  signInWithWallet: (
    verifyingKey: string,
    network: string,
    token: string,
    operatorId: string,
  ) => void;
  signOut: () => void;
}

const SessionContext = createContext<Session>({
  token: null,
  operatorId: null,
  walletVerifyingKey: null,
  walletNetwork: null,
  signIn: async () => {},
  signInWithWallet: () => {},
  signOut: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [operatorId, setOperatorState] = useState<string | null>(() =>
    getOperator(),
  );
  const [walletVerifyingKey, setWalletVk] = useState<string | null>(() =>
    getStored(WALLET_KEY),
  );
  const [walletNetwork, setWalletNetwork] = useState<string | null>(() =>
    getStored(WALLET_NETWORK_KEY),
  );

  // Account-switch guard: if a wallet session exists and a DIFFERENT key
  // signs in, the old identity must not silently persist — full reset.
  const signInWithWallet = useCallback(
    (
      verifyingKey: string,
      network: string,
      nextToken: string,
      nextOperator: string,
    ) => {
      setToken(nextToken);
      setTokenState(nextToken);
      setOperatorState(nextOperator);
      setWalletVk(verifyingKey);
      setWalletNetwork(network);
      try {
        window.localStorage.setItem(OPERATOR_KEY, nextOperator);
        window.localStorage.setItem(WALLET_KEY, verifyingKey);
        window.localStorage.setItem(WALLET_NETWORK_KEY, network);
      } catch {
        // ignore persistence failure
      }
    },
    [],
  );

  const signIn = useCallback(async (devKey: string, externalKey: string) => {
    const session = await api.createSession(devKey, externalKey);
    setToken(session.token);
    setTokenState(session.token);
    setOperatorState(session.operatorId);
    try {
      window.localStorage.setItem(OPERATOR_KEY, session.operatorId);
    } catch {
      // ignore persistence failure
    }
  }, []);

  const signOut = useCallback(() => {
    // Best-effort server revocation; local state clears regardless.
    // All identity material (token, operator, wallet binding) clears —
    // disconnect never leaves a stale operator behind.
    void api.signOut().catch(() => undefined);
    setToken(null);
    setTokenState(null);
    setOperatorState(null);
    setWalletVk(null);
    setWalletNetwork(null);
    try {
      window.localStorage.removeItem(OPERATOR_KEY);
      window.localStorage.removeItem(WALLET_KEY);
      window.localStorage.removeItem(WALLET_NETWORK_KEY);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      signOut();
      try {
        window.sessionStorage.setItem(EXPIRED_FLAG, "1");
      } catch {
        // ignore
      }
      if (!window.location.hash.startsWith("#/login")) {
        window.location.hash = "#/login";
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const value = useMemo(
    () => ({
      token,
      operatorId,
      walletVerifyingKey,
      walletNetwork,
      signIn,
      signInWithWallet,
      signOut,
    }),
    [
      token,
      operatorId,
      walletVerifyingKey,
      walletNetwork,
      signIn,
      signInWithWallet,
      signOut,
    ],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  return useContext(SessionContext);
}
