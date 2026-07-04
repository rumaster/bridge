import { describe, expect, it } from "vitest";

import { createManagerWorkspaceApiClient } from "../src/api/client/http";
import { createMockC7RealtimeClient } from "../src/api/client/realtime";

describe("Manager Workspace MSW mocks", () => {
  it("serves C3.auth, C3.conversations, C3.messages, C3.clients and C10.notifications", async () => {
    const api = createManagerWorkspaceApiClient({ baseUrl: "/api/v1" });

    const login = await api.auth.startTelegramLogin({ telegramUsername: "manager_demo" });
    expect(login.delivery).toBe("telegram");

    const session = await api.auth.verifyTelegramLogin({
      requestId: login.requestId,
      code: "000000"
    });
    expect(session.user.displayName).toBe("Демо Менеджер");

    const conversations = await api.conversations.list();
    expect(conversations).toHaveLength(2);

    const messages = await api.conversations.listMessages("conv-1");
    expect(messages[0]?.conversationId).toBe("conv-1");

    const createdMessage = await api.messages.create({
      conversationId: "conv-1",
      content: "Проверка ответа менеджера",
      idempotencyKey: "repeatable-message-key"
    });
    const repeatedMessage = await api.messages.create({
      conversationId: "conv-1",
      content: "Проверка ответа менеджера",
      idempotencyKey: "repeatable-message-key"
    });
    expect(repeatedMessage).toEqual(createdMessage);

    const messagesAfterRepeat = await api.conversations.listMessages("conv-1");
    expect(messagesAfterRepeat.filter((message) => message.id === createdMessage.id)).toHaveLength(1);

    const client = await api.clients.get("client-1");
    expect(client.displayName).toBe("Анна Петрова");

    const notifications = await api.notifications.list();
    expect(notifications.some((item) => item.status === "new")).toBe(true);
    const notificationCategories = new Set(notifications.map((item) => item.category));
    expect(notificationCategories.has("info")).toBe(true);
    expect(notificationCategories.has("warning")).toBe(true);

    const readNotification = await api.notifications.markRead("notif-1");
    expect(readNotification.status).toBe("read");

    const suggestion = await api.ai.suggest({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: "mws-c4-request-1",
      organization_id: "org-1",
      conversation_id: "conv-1",
      requester_user_id: "manager-1",
      query: "Как ответить по доставке заказа?",
      context: {
        messages: [
          {
            message_id: "msg-1",
            sender_type: "client",
            text: "Хочу уточнить статус заказа",
            occurred_at: "2026-07-02T16:09:15.000Z"
          }
        ]
      }
    });
    expect(suggestion.contract).toBe("C4.AssistantSuggestResponse");
    expect(suggestion.sources[0]?.source_type).toBe("knowledge_chunk");
  });

  it("starts a C7 realtime mock and emits typed events", async () => {
    const realtime = createMockC7RealtimeClient();
    const events = await realtime.collectInitialEvents();

    expect(events.map((event) => event.event)).toContain("message.created");
    expect(events.map((event) => event.event)).toContain("notification.created");

    const notificationEvent = events.find((event) => event.event === "notification.created");
    expect(notificationEvent?.event === "notification.created" && notificationEvent.payload.notification.status).toBe(
      "new"
    );
    expect(
      notificationEvent?.event === "notification.created" && notificationEvent.payload.notification.category
    ).toBe("critical");
  });
});
