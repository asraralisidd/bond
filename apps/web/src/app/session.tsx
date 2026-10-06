/**
 * Session state: token in localStorage, operator id alongside it.
 * No global store library — one context is sufficient.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, getToken, setToken } from "../api/client.js";

const OPERATOR_KEY = "bond.session.operator";

function getOperator(): string | null {
  try {
    return window.localStorage.getItem(OPERATOR_KEY);
  } catch {
    return null;
  }
}

interface Session {
  token: string | null;
  operatorId: string | null;
  signIn: (devKey: string, externalKey: string) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<Session>({
  token: null,
  operatorId: null,
  signIn: async () => {},
  signOut: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [operatorId, setOperatorState] = useState<string | null>(() =>
    getOperator(),
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
    setToken(null);
    setTokenState(null);
    setOperatorState(null);
    try {
      window.localStorage.removeItem(OPERATOR_KEY);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(
    () => ({ token, operatorId, signIn, signOut }),
    [token, operatorId, signIn, signOut],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  return useContext(SessionContext);
}
