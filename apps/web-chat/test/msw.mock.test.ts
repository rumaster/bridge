import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import { webChatMockHandlers } from "../src/mocks/handlers";

describe("Bridge Web Chat MSW mocks", () => {
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

  it("содержит мок C7 WebSocket", () => {
    expect(
      webChatMockHandlers.some((handler) => handler.kind === "websocket"),
    ).toBe(true);
  });
});
