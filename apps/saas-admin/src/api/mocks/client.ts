import type {
  AdminSession,
  Organization,
  OrganizationConfiguration,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginVerifyRequest
} from "../client/types";
import { mockConfiguration, mockOrganization, mockSession } from "./fixtures";

export interface CreateMockSaasAdminServicesOptions {
  authenticated?: boolean;
}

export function createMockSaasAdminApiClient(
  options: CreateMockSaasAdminServicesOptions = {}
): SaasAdminApiClient {
  let currentSession: AdminSession | null = options.authenticated === false ? null : mockSession;

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
          requestId: "admin-login-request-1",
          delivery: "telegram",
          expiresAt: "2026-07-02T16:20:00.000Z"
        };
      },
      async verifyTelegramLogin(request: TelegramLoginVerifyRequest) {
        if (!request.requestId || !request.code) {
          throw new Error("requestId and code are required");
        }

        currentSession = mockSession;
        return mockSession;
      },
      async logout() {
        currentSession = null;
      }
    },
    org: {
      async getOrganization(organizationId: string) {
        return findOrganization(organizationId);
      },
      async getConfiguration(organizationId: string) {
        if (organizationId !== mockConfiguration.organizationId) {
          throw new Error("Organization configuration not found");
        }

        return mockConfiguration;
      }
    }
  };
}

export function createMockSaasAdminServices(options: CreateMockSaasAdminServicesOptions = {}) {
  return {
    api: createMockSaasAdminApiClient(options)
  };
}

function findOrganization(organizationId: string): Organization {
  if (organizationId !== mockOrganization.id) {
    throw new Error("Organization not found");
  }

  return mockOrganization;
}

export function cloneMockOrganization(): Organization {
  return { ...mockOrganization };
}

export function cloneMockConfiguration(): OrganizationConfiguration {
  return { ...mockConfiguration };
}
