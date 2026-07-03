import type {
  AdminSession,
  Organization,
  OrganizationConfiguration,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginVerifyRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest
} from "../client/types";
import { mockConfiguration, mockOrganization, mockSession } from "./fixtures";

export interface CreateMockSaasAdminServicesOptions {
  authenticated?: boolean;
  session?: AdminSession;
}

export function createMockSaasAdminApiClient(
  options: CreateMockSaasAdminServicesOptions = {}
): SaasAdminApiClient {
  const initialSession = options.session ?? mockSession;
  let currentSession: AdminSession | null = options.authenticated === false ? null : initialSession;
  let currentOrganization: Organization = cloneMockOrganization();
  let currentConfiguration: OrganizationConfiguration = cloneMockConfiguration();

  return {
    auth: {
      async getSession() {
        if (!currentSession) {
          throw new Error("Session not found");
        }

        return currentSession;
      },
      async startTelegramLogin(request: TelegramLoginStartRequest) {
        if (!request.telegramUsername) {
          throw new Error("telegramUsername is required");
        }

        return {
          status: "mock_code_delivery_scheduled",
          deliveryChannel: "telegram",
          telegramUsername: request.telegramUsername.replace(/^@/, "").toLowerCase(),
          expiresInSeconds: 300,
          implementationStage: "M1"
        };
      },
      async verifyTelegramLogin(request: TelegramLoginVerifyRequest) {
        if (!request.telegramUsername || !request.code) {
          throw new Error("telegramUsername and code are required");
        }

        currentSession = initialSession;
        return initialSession;
      },
      async logout() {
        currentSession = null;
        return {
          loggedOut: true,
          sessionMode: "mock",
          implementationStage: "M1"
        };
      }
    },
    org: {
      async getOrganization(organizationId: string) {
        if (organizationId !== currentOrganization.id) {
          throw new Error("Organization not found");
        }

        return currentOrganization;
      },
      async updateOrganization(
        organizationId: string,
        request: UpdateOrganizationRequest
      ) {
        if (organizationId !== currentOrganization.id) {
          throw new Error("Organization not found");
        }

        currentOrganization = {
          ...currentOrganization,
          ...request,
          updatedAt: "2026-07-03T09:30:00.000Z"
        };

        return currentOrganization;
      },
      async getConfiguration(organizationId: string) {
        if (organizationId !== currentConfiguration.organizationId) {
          throw new Error("Organization configuration not found");
        }

        return currentConfiguration;
      },
      async updateConfiguration(
        organizationId: string,
        request: UpdateOrganizationConfigurationRequest
      ) {
        if (organizationId !== currentConfiguration.organizationId) {
          throw new Error("Organization configuration not found");
        }

        currentConfiguration = {
          ...currentConfiguration,
          ...request,
          updatedAt: "2026-07-03T09:31:00.000Z"
        };

        return currentConfiguration;
      }
    }
  };
}

export function createMockSaasAdminServices(options: CreateMockSaasAdminServicesOptions = {}) {
  return {
    api: createMockSaasAdminApiClient(options)
  };
}

export function cloneMockOrganization(): Organization {
  return { ...mockOrganization };
}

export function cloneMockConfiguration(): OrganizationConfiguration {
  return { ...mockConfiguration };
}
