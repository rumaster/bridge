import { afterEach, describe, expect, it } from "vitest";

import { createManagerWorkspaceApiClient } from "../src/api/client/http";
import { MANAGER_WORKSPACE_SESSION_STORAGE_KEY } from "../src/state/session-storage";

const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000101";

describe("Manager Workspace API client tenant scope", () => {
  afterEach(() => {
    window.localStorage.removeItem(MANAGER_WORKSPACE_SESSION_STORAGE_KEY);
  });

  it("sends x-organization-id from the stored session and normalizes tenant menu responses", async () => {
    window.localStorage.setItem(
      MANAGER_WORKSPACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "brs_manager_demo",
        user: {
          id: "30000000-0000-4000-8000-000000000202",
          displayName: "Manager Demo",
          role: "manager",
          telegramUsername: "manager_demo"
        },
        organization: {
          id: ORGANIZATION_ID,
          name: "Tenant A"
        },
        expiresAt: "2099-01-01T00:00:00.000Z"
      })
    );
    const requestedPaths: string[] = [];

    const api = createManagerWorkspaceApiClient({
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

    await expect(api.conversations.list()).resolves.toEqual([
      expect.objectContaining({
        clientId: "30000000-0000-4000-8000-000000000301",
        id: "30000000-0000-4000-8000-000000000501",
        lastMessageAt: "2026-07-04T10:02:00.000Z"
      })
    ]);
    await expect(api.clients.list()).resolves.toEqual([
      expect.objectContaining({
        displayName: "Клиент без имени",
        endpoints: [],
        id: "30000000-0000-4000-8000-000000000301",
        notes: [],
        tags: []
      })
    ]);
    expect(requestedPaths).toEqual(["/api/v1/conversations", "/api/v1/clients"]);
  });
});

function responseForPath(url: string) {
  const path = new URL(url, "http://localhost").pathname;

  if (path === "/api/v1/conversations") {
    return {
      items: [
        {
          id: "30000000-0000-4000-8000-000000000501",
          organizationId: ORGANIZATION_ID,
          clientId: "30000000-0000-4000-8000-000000000301",
          status: "open",
          lastMessageAt: null,
          createdAt: "2026-07-04T10:01:00.000Z",
          updatedAt: "2026-07-04T10:02:00.000Z"
        }
      ],
      page: { limit: 50, total: 1 }
    };
  }

  return {
    items: [
      {
        id: "30000000-0000-4000-8000-000000000301",
        organizationId: ORGANIZATION_ID,
        displayName: null,
        createdAt: "2026-07-04T10:00:00.000Z",
        updatedAt: "2026-07-04T10:00:00.000Z"
      }
    ],
    page: { limit: 50, total: 1 }
  };
}
