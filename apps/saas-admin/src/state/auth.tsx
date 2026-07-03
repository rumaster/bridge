import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import type {
  AdminRole,
  AdminSession,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest
} from "../api/client/types";

type AuthStatus = "loading" | "anonymous" | "authenticated";

export const SAAS_ADMIN_SESSION_STORAGE_KEY = "bridge.saas-admin.session";

interface AuthContextValue {
  session: AdminSession | null;
  status: AuthStatus;
  startTelegramLogin: (request: TelegramLoginStartRequest) => Promise<TelegramLoginStartResponse>;
  verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => Promise<AdminSession>;
  refreshSession: () => Promise<AdminSession>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps extends PropsWithChildren {
  api: SaasAdminApiClient;
}

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [session, setSession] = useState<AdminSession | null>(() => readStoredSession());
  const [status, setStatus] = useState<AuthStatus>(() =>
    readStoredSession() ? "authenticated" : "loading"
  );

  const applySession = useCallback((nextSession: AdminSession) => {
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
          if (!storedSession) {
            clearSession();
          } else {
            removeStoredSession();
            setSession(null);
            setStatus("anonymous");
          }
        }
      });

    return () => {
      active = false;
    };
  }, [api, applySession, clearSession]);

  const startTelegramLogin = useCallback(
    (request: TelegramLoginStartRequest) => api.auth.startTelegramLogin(request),
    [api]
  );

  const verifyTelegramLogin = useCallback(async (request: TelegramLoginVerifyRequest) => {
    const nextSession = await api.auth.verifyTelegramLogin(request);
    return applySession(nextSession);
  }, [api, applySession]);

  const refreshSession = useCallback(async () => {
    const nextSession = await api.auth.getSession();
    return applySession(nextSession);
  }, [api, applySession]);

  useEffect(() => {
    if (status !== "authenticated") {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshSession().catch(() => {
        clearSession();
      });
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [clearSession, refreshSession, status]);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      clearSession();
    }
  }, [api]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      status,
      startTelegramLogin,
      verifyTelegramLogin,
      refreshSession,
      logout
    }),
    [logout, refreshSession, session, startTelegramLogin, status, verifyTelegramLogin]
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

export function hasAnyRole(session: AdminSession | null, roles: AdminRole[]) {
  return Boolean(session?.roles.some((role) => roles.includes(role)));
}

function readStoredSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(SAAS_ADMIN_SESSION_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as AdminSession;
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

function storeSession(session: AdminSession) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SAAS_ADMIN_SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

function removeStoredSession() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(SAAS_ADMIN_SESSION_STORAGE_KEY);
  }
}

function isExpired(session: AdminSession) {
  const expiresAt = session.session.expiresAt;
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
