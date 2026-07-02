import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { createSaasAdminApiClient } from "../api/client/http";
import type { SaasAdminApiClient } from "../api/client/types";
import { AuthProvider } from "./auth";

export interface SaasAdminServices {
  api: SaasAdminApiClient;
}

export interface SaasAdminProvidersProps extends PropsWithChildren {
  services?: SaasAdminServices;
}

const defaultServices: SaasAdminServices = {
  api: createSaasAdminApiClient()
};

const ServicesContext = createContext<SaasAdminServices | null>(null);

export function SaasAdminProviders({ children, services }: SaasAdminProvidersProps) {
  const value = useMemo(() => services ?? defaultServices, [services]);

  return (
    <ServicesContext.Provider value={value}>
      <AuthProvider api={value.api}>{children}</AuthProvider>
    </ServicesContext.Provider>
  );
}

export function useSaasAdminApi() {
  return useSaasAdminServices().api;
}

function useSaasAdminServices() {
  const value = useContext(ServicesContext);

  if (!value) {
    throw new Error("SaaS Administration services are not available");
  }

  return value;
}
