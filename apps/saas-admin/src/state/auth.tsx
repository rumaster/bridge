import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import type { AdminSession, SaasAdminApiClient } from "../api/client/types";

type AuthStatus = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  session: AdminSession | null;
  status: AuthStatus;
  loginAsDemoAdmin: () => Promise<AdminSession>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps extends PropsWithChildren {
  api: SaasAdminApiClient;
}

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let active = true;

    api.auth
      .getSession()
      .then((nextSession) => {
        if (active) {
          setSession(nextSession);
          setStatus("authenticated");
        }
      })
      .catch(() => {
        if (active) {
          setSession(null);
          setStatus("anonymous");
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const loginAsDemoAdmin = useCallback(async () => {
    const login = await api.auth.startTelegramLogin({ telegramUsername: "admin_demo" });
    const nextSession = await api.auth.verifyTelegramLogin({
      requestId: login.requestId,
      code: "000000"
    });

    setSession(nextSession);
    setStatus("authenticated");
    return nextSession;
  }, [api]);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setSession(null);
    setStatus("anonymous");
  }, [api]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      status,
      loginAsDemoAdmin,
      logout
    }),
    [loginAsDemoAdmin, logout, session, status]
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
