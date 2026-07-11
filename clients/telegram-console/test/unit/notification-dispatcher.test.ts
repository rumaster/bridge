import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramConsoleNotificationDispatcher } from "../../src/notification-dispatcher.js";
import { createTelegramConsoleSessionStore } from "../../src/session-store.js";

const fixedNow = () => "2026-07-04T10:00:00.000Z";

function notification(overrides = {}) {
  return {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notif-1",
    organization_id: "org-1",
    recipient_user_id: "manager-1",
    category: "info",
    title: "Новое сообщение",
    body: "Клиент ожидает ответа",
    payload: { conversation_id: "conv-1" },
    status: "new",
    channels: ["web", "telegram"],
    created_at: "2026-07-04T09:59:00.000Z",
    read_at: null,
    ...overrides,
  };
}

function stubRouter() {
  const calls: Array<{ chatId: unknown; notification: any }> = [];
  return {
    calls,
    deliverNotification: async (input: any) => {
      calls.push(input);
      return { route: "notification:telegram", status: "delivered", notification_id: input.notification.id };
    },
  };
}

describe("Telegram Console notification dispatcher (G-8)", () => {
  it("resolves the manager chat_id from the linked session and delivers the card", async () => {
    const sessionStore = createTelegramConsoleSessionStore({ now: fixedNow });
    sessionStore.setSession(1001, {
      token: "session-token",
      user: { id: "manager-1", display_name: "Демо Менеджер" },
      organization: { id: "org-1" },
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    const router = stubRouter();
    const dispatcher = createTelegramConsoleNotificationDispatcher({ router, sessionStore });

    const result = await dispatcher.deliver(notification());

    assert.equal(result.status, "delivered");
    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].chatId, 1001);
    assert.equal(router.calls[0].notification.id, "notif-1");
  });

  it("prefers an explicit chat_id from the notification payload", async () => {
    const router = stubRouter();
    const dispatcher = createTelegramConsoleNotificationDispatcher({
      router,
      sessionStore: { findChatIdByUserId: () => null },
    });

    await dispatcher.deliver(notification({ payload: { conversation_id: "conv-1", telegram_chat_id: 2002 } }));

    assert.equal(router.calls[0].chatId, 2002);
  });

  it("skips (no-linked-chat) when the recipient has no linked Telegram session", async () => {
    const sessionStore = createTelegramConsoleSessionStore({ now: fixedNow });
    const router = stubRouter();
    const dispatcher = createTelegramConsoleNotificationDispatcher({
      router,
      sessionStore,
      logger: { warn() {} },
    });

    const result = await dispatcher.deliver(notification());

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-linked-chat");
    assert.equal(router.calls.length, 0);
  });

  it("skips (telegram-channel-not-enabled) when telegram is not among the notification channels", async () => {
    const router = stubRouter();
    const dispatcher = createTelegramConsoleNotificationDispatcher({
      router,
      sessionStore: { findChatIdByUserId: () => 1001 },
    });

    const result = await dispatcher.deliver(notification({ channels: ["web", "email"] }));

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "telegram-channel-not-enabled");
    assert.equal(router.calls.length, 0);
  });
});
