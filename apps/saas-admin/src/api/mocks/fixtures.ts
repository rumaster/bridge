import type {
  AdminRole,
  AdminSession,
  Organization,
  OrganizationConfiguration
} from "../client/types";

export const mockSession: AdminSession = {
  authenticated: true,
  user: {
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "org-demo",
    displayName: "Демо Администратор",
    telegramUsername: "admin_demo",
    status: "active"
  },
  organization: {
    id: "org-demo",
    slug: "demo-organization",
    name: "Демо Организация"
  },
  roles: ["administrator"],
  session: {
    id: "mock-session-m1",
    mode: "mock",
    issuedAt: "2026-07-03T09:00:00.000Z",
    expiresAt: null
  },
  implementationStage: "M1"
};

export const mockOrganization: Organization = {
  id: "org-demo",
  name: "Демо Организация",
  description: "Организация для проверки M1-входа и конфигурации админ-панели.",
  timezone: "Europe/Moscow",
  locale: "ru-RU",
  status: "active",
  updatedAt: "2026-07-02T16:10:00.000Z"
};

export const mockConfiguration: OrganizationConfiguration = {
  organizationId: "org-demo",
  defaultLanguage: "ru",
  aiAssistantEnabled: true,
  workflowAutomationEnabled: true,
  monthlyMessageLimit: 10000,
  notificationEmail: "admin@example.test",
  retentionDays: 90,
  updatedAt: "2026-07-03T09:12:00.000Z"
};

export function createMockSession(roles: AdminRole[] = ["administrator"]): AdminSession {
  return {
    ...mockSession,
    user: { ...mockSession.user },
    organization: { ...mockSession.organization },
    roles: [...roles],
    session: { ...mockSession.session }
  };
}
