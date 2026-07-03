import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { createSaasAdminApiClient } from "../api/client/http";
import { createBrowserC7RealtimeClient, createMockC7RealtimeClient } from "../api/client/realtime";
import type { C7RealtimeClient } from "../api/client/realtime";
import type { SaasAdminApiClient } from "../api/client/types";
import { AuthProvider } from "./auth";

export interface SaasAdminServices {
  api: SaasAdminApiClient;
  realtime: C7RealtimeClient;
}

export type SaasAdminServiceOverrides = Partial<SaasAdminServices>;

export interface SaasAdminProvidersProps extends PropsWithChildren {
  services?: SaasAdminServiceOverrides;
}

const defaultServices: SaasAdminServices = {
  api: createSaasAdminApiClient(),
  realtime: createDefaultC7RealtimeClient()
};

const ServicesContext = createContext<SaasAdminServices | null>(null);

export function SaasAdminProviders({ children, services }: SaasAdminProvidersProps) {
  const value = useMemo<SaasAdminServices>(
    () => (services ? { ...defaultServices, ...services } : defaultServices),
    [services]
  );

  return (
    <ServicesContext.Provider value={value}>
      <AuthProvider api={value.api}>{children}</AuthProvider>
    </ServicesContext.Provider>
  );
}

export function useSaasAdminApi() {
  return useSaasAdminServices().api;
}

export function useC7RealtimeClient() {
  return useSaasAdminServices().realtime;
}

function useSaasAdminServices() {
  const value = useContext(ServicesContext);

  if (!value) {
    throw new Error("SaaS Administration services are not available");
  }

  return value;
}

function createDefaultC7RealtimeClient() {
  if (import.meta.env.DEV && import.meta.env.VITE_SAAS_ADMIN_MOCKS === "true") {
    return createMockC7RealtimeClient();
  }

  return createBrowserC7RealtimeClient();
}
