import { describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";

describe("SaaS Administration MSW mocks", () => {
  it("serves C3.auth and C3.org M0 mock contracts", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const login = await api.auth.startTelegramLogin({ telegramUsername: "admin_demo" });
    expect(login.delivery).toBe("telegram");

    const session = await api.auth.verifyTelegramLogin({
      requestId: login.requestId,
      code: "000000"
    });
    expect(session.user.role).toBe("administrator");

    const organization = await api.org.getOrganization(session.organization.id);
    expect(organization.name).toBe("Демо Организация");

    const configuration = await api.org.getConfiguration(session.organization.id);
    expect(configuration.workflowAutomationEnabled).toBe(true);

    await expect(api.auth.logout()).resolves.toBeUndefined();
  });
});
