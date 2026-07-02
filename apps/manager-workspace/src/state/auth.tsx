import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import type {
  ManagerSession,
  ManagerWorkspaceApiClient,
  TelegramLoginStartResponse
} from "../api/client/types";

type AuthStatus = "loading" | "anonymous" | "authenticated";

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
  const [session, setSession] = useState<ManagerSession | null>(null);
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
          setStatus("anonymous");
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const startTelegramLogin = useCallback(
    (telegramUsername: string) => api.auth.startTelegramLogin({ telegramUsername }),
    [api]
  );

  const verifyTelegramLogin = useCallback(
    async (requestId: string, code: string) => {
      const nextSession = await api.auth.verifyTelegramLogin({ requestId, code });
      setSession(nextSession);
      setStatus("authenticated");
      return nextSession;
    },
    [api]
  );

  const logout = useCallback(async () => {
    await api.auth.logout();
    setSession(null);
    setStatus("anonymous");
  }, [api]);

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
