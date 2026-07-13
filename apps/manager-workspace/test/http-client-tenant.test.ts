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

  it("downloads an attachment as a blob with the tenant header (§4.3)", async () => {
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
        organization: { id: ORGANIZATION_ID, name: "Tenant A" },
        expiresAt: "2099-01-01T00:00:00.000Z"
      })
    );
    const attachmentId = "30000000-0000-4000-8000-0000000006a1";
    let requestedPath = "";
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        requestedPath = new URL(String(url), "http://localhost").pathname;
        // Скачивание несёт tenant-заголовок (иначе backend-прокси вернул бы 400).
        expect(new Headers(init?.headers).get("x-organization-id")).toBe(ORGANIZATION_ID);
        return new Response("PDF-BYTES", {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
    });

    const blob = await api.attachments.download(attachmentId);
    expect(requestedPath).toBe(`/api/v1/attachments/${attachmentId}/content`);
    expect(await blob.text()).toBe("PDF-BYTES");
  });

  it("throws when attachment download fails", async () => {
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async () => new Response("nope", { status: 404 })
    });
    await expect(api.attachments.download("30000000-0000-4000-8000-0000000006a1")).rejects.toThrow();
  });

  it("preserves the email channel and nests the reply subject into content (E5)", async () => {
    let sentBody: any;
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if (path === "/api/v1/messages") {
          sentBody = JSON.parse(String(init?.body));
        }
        return new Response(
          JSON.stringify({
            id: "30000000-0000-4000-8000-000000000601",
            conversationId: "conv-1",
            channel: "email",
            direction: "outbound",
            senderType: "manager",
            content: { text: "Ответ", subject: "Re: заявка" },
            status: "routed",
            createdAt: "2026-07-11T10:00:00.000Z"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const message = await api.messages.create({
      conversationId: "conv-1",
      content: "Ответ",
      idempotencyKey: "idem-1",
      subject: "Re: заявка"
    });

    // Email не приводится к web_chat.
    expect(message.channel).toBe("email");
    // Тема ушла внутрь content как объект {text, subject}.
    expect(sentBody).toEqual({
      conversationId: "conv-1",
      idempotencyKey: "idem-1",
      content: { text: "Ответ", subject: "Re: заявка" }
    });
  });

  it("uploads a file with tenant header + encoded filename and returns the descriptor", async () => {
    window.localStorage.setItem(
      MANAGER_WORKSPACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "brs_manager_demo",
        user: { id: "u", displayName: "M", role: "manager", telegramUsername: "m" },
        organization: { id: ORGANIZATION_ID, name: "Tenant A" },
        expiresAt: "2099-01-01T00:00:00.000Z"
      })
    );
    let requestedPath = "";
    let method = "";
    let filenameHeader: string | null = null;
    const storageRef = `edge-attach://${ORGANIZATION_ID}/${"a".repeat(64)}`;
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        requestedPath = new URL(String(url), "http://localhost").pathname;
        method = String(init?.method);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-organization-id")).toBe(ORGANIZATION_ID);
        filenameHeader = headers.get("x-attachment-filename");
        return new Response(
          JSON.stringify({ storageRef, name: "отчёт.pdf", contentType: "application/pdf", sizeBytes: 9 }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
    });

    const file = new File([new Uint8Array([1, 2, 3])], "отчёт.pdf", { type: "application/pdf" });
    const descriptor = await api.attachments.upload(file);

    expect(requestedPath).toBe("/api/v1/attachments");
    expect(method).toBe("POST");
    // Кириллическое имя уходит URL-encoded (ASCII-safe заголовок).
    expect(filenameHeader).toBe(encodeURIComponent("отчёт.pdf"));
    expect(descriptor.storageRef).toBe(storageRef);
    expect(descriptor.name).toBe("отчёт.pdf");
  });

  it("throws when attachment upload fails", async () => {
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async () => new Response("too big", { status: 413 })
    });
    const file = new File([new Uint8Array([1])], "f.bin");
    await expect(api.attachments.upload(file)).rejects.toThrow();
  });

  it("includes uploaded attachment descriptors in the POST /messages body", async () => {
    let sentBody: any;
    const storageRef = `edge-attach://${ORGANIZATION_ID}/${"b".repeat(64)}`;
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if (path === "/api/v1/messages") {
          sentBody = JSON.parse(String(init?.body));
        }
        return new Response(
          JSON.stringify({
            id: "30000000-0000-4000-8000-000000000601",
            conversationId: "conv-1",
            channel: "email",
            direction: "outbound",
            senderType: "manager",
            content: { text: "во вложении", subject: "Re: заявка" },
            status: "routed",
            createdAt: "2026-07-11T10:00:00.000Z"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    await api.messages.create({
      conversationId: "conv-1",
      content: "во вложении",
      idempotencyKey: "idem-3",
      subject: "Re: заявка",
      attachments: [
        { storageRef, name: "отчёт.pdf", contentType: "application/pdf", sizeBytes: 2048 }
      ]
    });

    expect(sentBody.attachments).toEqual([
      { storageRef, name: "отчёт.pdf", contentType: "application/pdf", sizeBytes: 2048 }
    ]);
    expect(sentBody.content).toEqual({ text: "во вложении", subject: "Re: заявка" });
  });

  it("keeps content as a plain string when no subject is provided", async () => {
    let sentBody: any;
    const api = createManagerWorkspaceApiClient({
      baseUrl: "/api/v1",
      fetcher: async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if (path === "/api/v1/messages") {
          sentBody = JSON.parse(String(init?.body));
        }
        return new Response(
          JSON.stringify({
            id: "30000000-0000-4000-8000-000000000601",
            conversationId: "conv-1",
            channel: "telegram",
            direction: "outbound",
            senderType: "manager",
            content: "Ответ",
            status: "routed",
            createdAt: "2026-07-11T10:00:00.000Z"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    await api.messages.create({ conversationId: "conv-1", content: "Ответ", idempotencyKey: "idem-2" });

    expect(sentBody.content).toBe("Ответ");
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
