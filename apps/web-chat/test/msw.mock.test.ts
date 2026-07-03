import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import { resetMockMessages, webChatMockHandlers } from "../src/mocks/handlers";
import type { WebChatMessage } from "../src/types";

describe("Bridge Web Chat MSW mocks", () => {
  it("создает анонимную Web Chat сессию для M1", async () => {
    const response = await fetch("http://localhost/api/v1/web-chat/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organization_id: DEFAULT_ORGANIZATION_ID,
        visitor_session_id: "visitor-session-1",
        conversation_id: DEFAULT_CONVERSATION_ID,
      }),
    });
    const session = await response.json();

    expect(response.status).toBe(201);
    expect(session).toMatchObject({
      visitorSessionId: "visitor-session-1",
      organizationId: DEFAULT_ORGANIZATION_ID,
      conversationId: DEFAULT_CONVERSATION_ID,
    });
  });

  it("стартует REST mock для C3.messages/C1", async () => {
    const response = await fetch(
      `http://localhost/api/v1/conversations/${DEFAULT_CONVERSATION_ID}/messages`,
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      items: [],
      page: {
        limit: 20,
        nextCursor: null,
        total: 0,
      },
    });
  });

  it("возвращает постраничную историю от новых сообщений к старым", async () => {
    resetMockMessages([
      mockMessage("52345678-1234-4234-8234-123456789abc", 1, "Первое"),
      mockMessage("62345678-1234-4234-8234-123456789abc", 2, "Второе"),
      mockMessage("72345678-1234-4234-8234-123456789abc", 3, "Третье"),
    ]);

    const latestResponse = await fetch(
      `http://localhost/api/v1/conversations/${DEFAULT_CONVERSATION_ID}/messages?limit=2`,
    );
    const latestPage = await latestResponse.json();

    expect(latestPage.items.map((message: WebChatMessage) => message.body.text)).toEqual([
      "Второе",
      "Третье",
    ]);
    expect(latestPage.page.nextCursor).toBe("before:2");

    const previousResponse = await fetch(
      `http://localhost/api/v1/conversations/${DEFAULT_CONVERSATION_ID}/messages?limit=2&cursor=before%3A2`,
    );
    const previousPage = await previousResponse.json();

    expect(previousPage.items.map((message: WebChatMessage) => message.body.text)).toEqual([
      "Первое",
    ]);
    expect(previousPage.page.nextCursor).toBe(null);
  });

  it("возвращает C1-подобное сообщение после POST /messages", async () => {
    const response = await fetch("http://localhost/api/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: DEFAULT_CONVERSATION_ID,
        organization_id: DEFAULT_ORGANIZATION_ID,
        body: {
          type: "text",
          text: "Проверка MSW",
        },
      }),
    });
    const message = await response.json();

    expect(response.status).toBe(201);
    expect(message).toMatchObject({
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      channel: "web_chat",
      body: {
        type: "text",
        text: "Проверка MSW",
      },
    });
  });

  it("не создает дубль при повторе POST /messages с тем же idempotency_key", async () => {
    const body = {
      conversation_id: DEFAULT_CONVERSATION_ID,
      idempotency_key: "12345678-1234-4234-8234-123456789abc",
      organization_id: DEFAULT_ORGANIZATION_ID,
      body: {
        type: "text",
        text: "Проверка идемпотентности",
      },
    };

    await fetch("http://localhost/api/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const repeatedResponse = await fetch("http://localhost/api/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const historyResponse = await fetch(
      `http://localhost/api/v1/conversations/${DEFAULT_CONVERSATION_ID}/messages`,
    );
    const history = await historyResponse.json();

    expect(repeatedResponse.status).toBe(200);
    expect(
      history.items.filter(
        (message: { id: string }) =>
          message.id === "12345678-1234-4234-8234-123456789abc",
      ),
    ).toHaveLength(1);
  });

  it("содержит мок C7 WebSocket", () => {
    expect(
      webChatMockHandlers.some((handler) => handler.kind === "websocket"),
    ).toBe(true);
  });
});

function mockMessage(id: string, sequenceNumber: number, text: string): WebChatMessage {
  return {
    id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    endpointId: DEFAULT_ENDPOINT_ID,
    channel: "web_chat",
    author: {
      type: "visitor",
      displayName: "Посетитель",
    },
    body: {
      type: "text",
      text,
    },
    createdAt: `2026-07-03T09:0${sequenceNumber}:00.000Z`,
    sequenceNumber,
    status: "delivered",
  };
}
