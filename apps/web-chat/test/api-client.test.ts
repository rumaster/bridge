import { describe, expect, it } from "vitest";
import { createWebChatApiClient } from "../src/platform/apiClient";

describe("Bridge Web Chat API client M1", () => {
  it("создает или восстанавливает анонимную сессию посетителя через public chat API", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        visitorSessionId: "visitor-session-1",
        organizationId: "22345678-1234-4234-8234-123456789abc",
        conversationId: "32345678-1234-4234-8234-123456789abc",
        endpointId: "42345678-1234-4234-8234-123456789abc",
      });
    };
    const client = createWebChatApiClient({
      baseUrl: "http://localhost/api/v1",
      fetcher,
    });

    const session = await client.createOrResumeSession({
      organizationId: "22345678-1234-4234-8234-123456789abc",
      visitorSessionId: "visitor-session-1",
      conversationId: "32345678-1234-4234-8234-123456789abc",
    });

    expect(session.conversationId).toBe("32345678-1234-4234-8234-123456789abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://localhost/api/v1/web-chat/sessions");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      organization_id: "22345678-1234-4234-8234-123456789abc",
      visitor_session_id: "visitor-session-1",
      conversation_id: "32345678-1234-4234-8234-123456789abc",
    });
  });

  it("отправляет сообщение с клиентским idempotency_key", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        id: "12345678-1234-4234-8234-123456789abc",
        idempotencyKey: "12345678-1234-4234-8234-123456789abc",
        organizationId: "22345678-1234-4234-8234-123456789abc",
        conversationId: "32345678-1234-4234-8234-123456789abc",
        endpointId: "42345678-1234-4234-8234-123456789abc",
        channel: "web_chat",
        author: {
          type: "visitor",
          displayName: "Посетитель",
        },
        body: {
          type: "text",
          text: "Здравствуйте",
        },
        createdAt: "2026-07-03T09:00:00.000Z",
        status: "sent",
      });
    };
    const client = createWebChatApiClient({
      baseUrl: "http://localhost/api/v1",
      fetcher,
    });

    await client.sendMessage({
      conversationId: "32345678-1234-4234-8234-123456789abc",
      endpointId: "42345678-1234-4234-8234-123456789abc",
      idempotencyKey: "12345678-1234-4234-8234-123456789abc",
      organizationId: "22345678-1234-4234-8234-123456789abc",
      text: "Здравствуйте",
      visitorSessionId: "visitor-session-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://localhost/api/v1/web-chat/messages");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe(
      "12345678-1234-4234-8234-123456789abc",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      conversation_id: "32345678-1234-4234-8234-123456789abc",
      endpoint_id: "42345678-1234-4234-8234-123456789abc",
      idempotency_key: "12345678-1234-4234-8234-123456789abc",
      organization_id: "22345678-1234-4234-8234-123456789abc",
      visitor_session_id: "visitor-session-1",
      body: {
        type: "text",
        text: "Здравствуйте",
      },
    });
  });

  it("получает страницу полной истории и нормализует C3/C1 backend response", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        items: [
          {
            id: "52345678-1234-4234-8234-123456789abc",
            organizationId: "22345678-1234-4234-8234-123456789abc",
            conversationId: "32345678-1234-4234-8234-123456789abc",
            endpointId: "42345678-1234-4234-8234-123456789abc",
            channel: "web_chat",
            direction: "outbound",
            senderType: "ai",
            sequenceNumber: 12,
            type: "text",
            content: {
              text: "AI уже ответил клиенту.",
            },
            status: "sent",
            createdAt: "2026-07-03T09:01:00.000Z",
            deliveredAt: null,
          },
        ],
        page: {
          limit: 25,
          nextCursor: "before:12",
          total: 42,
        },
      });
    };
    const client = createWebChatApiClient({
      baseUrl: "http://localhost/api/v1",
      fetcher,
    });

    const page = await client.getMessages("32345678-1234-4234-8234-123456789abc", {
      afterSequenceNumber: 10,
      cursor: "after:10",
      limit: 25,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      "http://localhost/api/v1/web-chat/conversations/32345678-1234-4234-8234-123456789abc/messages?limit=25&cursor=after%3A10&after_sequence_number=10",
    );
    expect(page.nextCursor).toBe("before:12");
    expect(page.hasMore).toBe(true);
    expect(page.messages).toEqual([
      {
        id: "52345678-1234-4234-8234-123456789abc",
        organizationId: "22345678-1234-4234-8234-123456789abc",
        conversationId: "32345678-1234-4234-8234-123456789abc",
        endpointId: "42345678-1234-4234-8234-123456789abc",
        channel: "web_chat",
        author: {
          type: "ai",
          displayName: "Bridge AI",
        },
        body: {
          type: "text",
          text: "AI уже ответил клиенту.",
        },
        createdAt: "2026-07-03T09:01:00.000Z",
        sequenceNumber: 12,
        status: "sent",
      },
    ]);
  });

  it("не отправляет after_sequence_number=0 (бессмысленный фильтр → бэкенд отбивал 400)", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ items: [], page: { limit: 20 } });
    };
    const client = createWebChatApiClient({ baseUrl: "http://localhost/api/v1", fetcher });

    await client.getMessages("32345678-1234-4234-8234-123456789abc", {
      afterSequenceNumber: 0,
      limit: 20,
    });

    expect(String(calls[0]?.input)).not.toContain("after_sequence_number");
  });
});
