import type { AdminSession, Organization, OrganizationConfiguration } from "../client/types";

export const mockSession: AdminSession = {
  token: "admin-session-token",
  user: {
    id: "user-admin-1",
    displayName: "Демо Администратор",
    role: "administrator",
    telegramUsername: "admin_demo"
  },
  organization: {
    id: "org-demo",
    name: "Демо Организация",
    status: "active"
  },
  expiresAt: "2026-07-02T18:00:00.000Z"
};

export const mockOrganization: Organization = {
  id: "org-demo",
  name: "Демо Организация",
  description: "Организация для проверки M0-каркаса админ-панели.",
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
  notificationEmail: "admin@example.test",
  updatedAt: "2026-07-02T16:12:00.000Z"
};
