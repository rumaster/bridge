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

  it("serves C3.channels and C3.kb M2 mock contracts", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const channels = await api.channels.listChannels();
    expect(channels.map((channel) => channel.name)).toContain("Основной Web Chat");
    expect(channels[0]).toHaveProperty("credentials_ref");
    expect(channels[0]).not.toHaveProperty("token");

    const createdChannel = await api.channels.createChannel({
      organization_id: "org-demo",
      channel_type: "web_chat",
      name: "Витрина Web Chat",
      credentials_ref: "secret://web-chat/org-demo/storefront",
      config: {
        widget_origin: "https://storefront.example.test"
      }
    });
    expect(createdChannel.channel.credentials_ref).toBe("secret://web-chat/org-demo/storefront");

    const capabilities = await api.channels.getCapabilities(createdChannel.channel.id);
    expect(capabilities.contract).toBe("C6.CapabilityDescriptor");
    expect(capabilities.capabilities.text.supported).toBe(true);

    await expect(api.channels.testChannel(createdChannel.channel.id)).resolves.toMatchObject({
      accepted: true,
      status: "connected"
    });

    const documents = await api.knowledge.listDocuments();
    expect(documents.map((document) => document.title)).toContain("Политика возвратов");

    const createdDocument = await api.knowledge.createDocument({
      organization_id: "org-demo",
      title: "Политика гарантий",
      content: "Гарантия на технику — 12 месяцев с даты покупки.",
      // Фразы нормализуются: тримминг, удаление пустых и дублей.
      embedding_sources: ["  гарантия на технику ", "", "гарантия на технику", "срок гарантии"]
    });
    expect(createdDocument.content).toContain("Гарантия");
    expect(createdDocument.embedding_sources).toEqual(["гарантия на технику", "срок гарантии"]);

    await expect(
      api.knowledge.updateDocument(createdDocument.id, {
        title: "Политика гарантий v2",
        content: "Гарантия — 24 месяца.",
        embedding_sources: ["гарантия 24 месяца"]
      })
    ).resolves.toMatchObject({
      title: "Политика гарантий v2",
      content: "Гарантия — 24 месяца.",
      embedding_sources: ["гарантия 24 месяца"]
    });

    await expect(api.knowledge.deleteDocument(createdDocument.id)).resolves.toMatchObject({
      deleted: true
    });
  });
});
