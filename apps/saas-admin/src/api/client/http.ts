import { createJsonApiClient } from "@bridge/api-client";
import type {
  AdminSession,
  LogoutResponse,
  Organization,
  OrganizationConfiguration,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest
} from "./types";

export interface SaasAdminApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "/api/v1";

export function createSaasAdminApiClient(options: SaasAdminApiClientOptions = {}): SaasAdminApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetcher: options.fetcher
  });

  return {
    auth: {
      getSession: () => requestJson<AdminSession>("/auth/session"),
      startTelegramLogin: (request: TelegramLoginStartRequest) =>
        requestJson<TelegramLoginStartResponse>("/auth/login/telegram/start", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      verifyTelegramLogin: (request: TelegramLoginVerifyRequest) =>
        requestJson<AdminSession>("/auth/login/telegram/verify", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      logout: () =>
        requestJson<LogoutResponse>("/auth/logout", {
          method: "POST"
        })
    },
    org: {
      getOrganization: (organizationId: string) =>
        requestJson<Organization>(`/organizations/${organizationId}`),
      updateOrganization: (organizationId: string, request: UpdateOrganizationRequest) =>
        requestJson<Organization>(`/organizations/${organizationId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      getConfiguration: (organizationId: string) =>
        requestJson<OrganizationConfiguration>(`/organizations/${organizationId}/configuration`),
      updateConfiguration: (
        organizationId: string,
        request: UpdateOrganizationConfigurationRequest
      ) =>
        requestJson<OrganizationConfiguration>(`/organizations/${organizationId}/configuration`, {
          method: "PUT",
          body: JSON.stringify(request)
        })
    }
  };
}
