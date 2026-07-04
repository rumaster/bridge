import { afterEach, describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";
import { SAAS_ADMIN_SESSION_STORAGE_KEY } from "../src/state/auth";

const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000101";

describe("SaaS Administration API client tenant scope", () => {
  afterEach(() => {
    window.localStorage.removeItem(SAAS_ADMIN_SESSION_STORAGE_KEY);
  });

  it("sends x-organization-id from the stored session for tenant-scoped menu requests", async () => {
    window.localStorage.setItem(
      SAAS_ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        authenticated: true,
        user: {
          id: "30000000-0000-4000-8000-000000000201",
          organizationId: ORGANIZATION_ID,
          displayName: "Admin Demo",
          telegramUsername: "admin_demo",
          status: "active"
        },
        organization: {
          id: ORGANIZATION_ID,
          slug: "tenant-a",
          name: "Tenant A"
        },
        roles: ["administrator"],
        session: {
          id: "30000000-0000-4000-8000-000000000901",
          mode: "server",
          issuedAt: "2026-07-04T10:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    const requestedPaths: string[] = [];

    const api = createSaasAdminApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        requestedPaths.push(new URL(String(url), "http://localhost").pathname);
        expect(new Headers(init?.headers).get("x-organization-id")).toBe(ORGANIZATION_ID);

        return new Response(JSON.stringify(responseForPath(String(url))), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(api.channels.listChannels()).resolves.toEqual([]);
    await expect(api.broadcasts.listBroadcasts()).resolves.toMatchObject({ items: [] });
    await expect(api.notifications.listNotifications()).resolves.toMatchObject({ items: [] });
    await expect(api.notifications.getSettings()).resolves.toMatchObject({ settings: [] });
    expect(requestedPaths).toEqual([
      "/api/v1/channels",
      "/api/v1/broadcasts",
      "/api/v1/notifications",
      "/api/v1/notifications/settings"
    ]);
  });
});

function responseForPath(url: string) {
  const path = new URL(url, "http://localhost").pathname;

  if (path === "/api/v1/broadcasts") {
    return {
      contract: "C8.ListBroadcastsResponse",
      version: "1.0.0",
      request_id: "test-broadcasts",
      organization_id: ORGANIZATION_ID,
      items: [],
      page: { limit: 50, offset: 0, total: 0 }
    };
  }

  if (path === "/api/v1/notifications") {
    return {
      contract: "C10.ListNotificationsResponse",
      version: "1.0.0",
      request_id: "test-notifications",
      organization_id: ORGANIZATION_ID,
      recipient_user_id: "30000000-0000-4000-8000-000000000201",
      items: [],
      page: { limit: 50, next_cursor: null }
    };
  }

  if (path === "/api/v1/notifications/settings") {
    return {
      contract: "C10.NotificationSettingsResponse",
      version: "1.0.0",
      request_id: "test-notification-settings",
      organization_id: ORGANIZATION_ID,
      user_id: "30000000-0000-4000-8000-000000000201",
      settings: []
    };
  }

  return [];
}
