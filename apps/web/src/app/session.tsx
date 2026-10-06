/**
 * Session state: token in localStorage, operator id alongside it.
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
    // Best-effort server revocation; local state clears regardless.
    void api.signOut().catch(() => undefined);
    setToken(null);
    setTokenState(null);
    setOperatorState(null);
    try {
      window.localStorage.removeItem(OPERATOR_KEY);
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
