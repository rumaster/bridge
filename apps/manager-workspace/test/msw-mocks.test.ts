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

    const readNotification = await api.notifications.markRead("notif-1");
    expect(readNotification.status).toBe("read");
  });

  it("starts a C7 realtime mock and emits typed events", async () => {
    const realtime = createMockC7RealtimeClient();
    const events = await realtime.collectInitialEvents();

    expect(events.map((event) => event.type)).toContain("message.created");
    expect(events.map((event) => event.type)).toContain("notification.created");
  });
});
