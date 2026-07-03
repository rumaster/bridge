import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { createManagerWorkspaceApiClient } from "../api/client/http";
import { createC7RealtimeClient } from "../api/client/realtime";
import type { C7RealtimeClient } from "../api/client/realtime";
import type { ManagerWorkspaceApiClient } from "../api/client/types";
import { AuthProvider } from "./auth";

export interface ManagerWorkspaceServices {
  api: ManagerWorkspaceApiClient;
  realtime: C7RealtimeClient;
}

export interface ManagerWorkspaceProvidersProps extends PropsWithChildren {
  services?: ManagerWorkspaceServices;
}

const defaultServices: ManagerWorkspaceServices = {
  api: createManagerWorkspaceApiClient(),
  realtime: createC7RealtimeClient()
};

const WorkspaceContext = createContext<ManagerWorkspaceServices | null>(null);

export function ManagerWorkspaceProviders({ children, services }: ManagerWorkspaceProvidersProps) {
  const value = useMemo(() => services ?? defaultServices, [services]);

  return (
    <WorkspaceContext.Provider value={value}>
      <AuthProvider api={value.api}>{children}</AuthProvider>
    </WorkspaceContext.Provider>
  );
}

export function useManagerWorkspaceApi() {
  const value = useWorkspaceServices();
  return value.api;
}

export function useC7RealtimeClient() {
  const value = useWorkspaceServices();
  return value.realtime;
}

function useWorkspaceServices() {
  const value = useContext(WorkspaceContext);

  if (!value) {
    throw new Error("Workspace services are not available");
  }

  return value;
}
