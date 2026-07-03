import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import { webChatMockHandlers } from "../src/mocks/handlers";

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
    await expect(response.json()).resolves.toEqual([]);
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
      history.filter(
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
