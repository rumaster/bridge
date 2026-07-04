import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import type {
  ManagerSession,
  ManagerWorkspaceApiClient,
  TelegramLoginStartResponse
} from "../api/client/types";
import { MANAGER_WORKSPACE_SESSION_STORAGE_KEY } from "./session-storage";

type AuthStatus = "loading" | "anonymous" | "authenticated";

export { MANAGER_WORKSPACE_SESSION_STORAGE_KEY } from "./session-storage";

interface AuthContextValue {
  session: ManagerSession | null;
  status: AuthStatus;
  startTelegramLogin: (telegramUsername: string) => Promise<TelegramLoginStartResponse>;
  verifyTelegramLogin: (requestId: string, code: string) => Promise<ManagerSession>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps extends PropsWithChildren {
  api: ManagerWorkspaceApiClient;
}

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [session, setSession] = useState<ManagerSession | null>(() => readStoredSession());
  const [status, setStatus] = useState<AuthStatus>(() =>
    readStoredSession() ? "authenticated" : "loading"
  );

  const applySession = useCallback((nextSession: ManagerSession) => {
    storeSession(nextSession);
    setSession(nextSession);
    setStatus("authenticated");
    return nextSession;
  }, []);

  const clearSession = useCallback(() => {
    removeStoredSession();
    setSession(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    let active = true;
    const storedSession = readStoredSession();

    api.auth
      .getSession()
      .then((nextSession) => {
        if (active) {
          applySession(nextSession);
        }
      })
      .catch(() => {
        if (active) {
          if (storedSession) {
            removeStoredSession();
            setSession(null);
          }
          setStatus("anonymous");
        }
      });

    return () => {
      active = false;
    };
  }, [api, applySession]);

  const startTelegramLogin = useCallback(
    (telegramUsername: string) => api.auth.startTelegramLogin({ telegramUsername }),
    [api]
  );

  const verifyTelegramLogin = useCallback(
    async (requestId: string, code: string) => {
      const nextSession = await api.auth.verifyTelegramLogin({ requestId, code });
      return applySession(nextSession);
    },
    [api, applySession]
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      clearSession();
    }
  }, [api, clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      status,
      startTelegramLogin,
      verifyTelegramLogin,
      logout
    }),
    [logout, session, startTelegramLogin, status, verifyTelegramLogin]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return value;
}

function readStoredSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(MANAGER_WORKSPACE_SESSION_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as ManagerSession;
    if (isExpired(parsed)) {
      removeStoredSession();
      return null;
    }

    return parsed;
  } catch {
    removeStoredSession();
    return null;
  }
}

function storeSession(session: ManagerSession) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(MANAGER_WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

function removeStoredSession() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(MANAGER_WORKSPACE_SESSION_STORAGE_KEY);
  }
}

function isExpired(session: ManagerSession) {
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
