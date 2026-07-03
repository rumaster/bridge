import { describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";

describe("SaaS Administration MSW mocks", () => {
  it("serves C3.auth and C3.org M1 mock contracts", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    await expect(api.auth.getSession()).rejects.toThrow("Authentication is required.");

    const login = await api.auth.startTelegramLogin({ telegramUsername: "admin_demo" });
    expect(login.deliveryChannel).toBe("telegram");

    const session = await api.auth.verifyTelegramLogin({
      telegramUsername: login.telegramUsername,
      code: "000000"
    });
    expect(session.roles).toContain("administrator");
    await expect(api.auth.getSession()).resolves.toMatchObject({ authenticated: true });

    const organization = await api.org.getOrganization(session.organization.id);
    expect(organization.name).toBe("Демо Организация");
    await expect(
      api.org.updateOrganization(session.organization.id, {
        name: "Bridge Operations",
        description: organization.description,
        timezone: organization.timezone,
        locale: organization.locale
      })
    ).resolves.toMatchObject({ name: "Bridge Operations" });

    const configuration = await api.org.getConfiguration(session.organization.id);
    expect(configuration.workflowAutomationEnabled).toBe(true);
    await expect(
      api.org.updateConfiguration(session.organization.id, {
        defaultLanguage: configuration.defaultLanguage,
        aiAssistantEnabled: configuration.aiAssistantEnabled,
        workflowAutomationEnabled: configuration.workflowAutomationEnabled,
        monthlyMessageLimit: 50,
        notificationEmail: configuration.notificationEmail,
        retentionDays: configuration.retentionDays
      })
    ).rejects.toThrow("Request payload does not match C3.org DTO.");

    await expect(
      api.org.updateConfiguration(session.organization.id, {
        defaultLanguage: "ru",
        aiAssistantEnabled: true,
        workflowAutomationEnabled: false,
        monthlyMessageLimit: 25000,
        notificationEmail: "ops@example.test",
        retentionDays: 120
      })
    ).resolves.toMatchObject({
      monthlyMessageLimit: 25000,
      workflowAutomationEnabled: false
    });

    await expect(api.auth.logout()).resolves.toMatchObject({ loggedOut: true });
    await expect(api.auth.getSession()).rejects.toThrow("Authentication is required.");
  });
});
