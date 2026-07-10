import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import {
  createMockTelegramApiAdapter,
  createTelegramConsoleNotificationDispatcher,
  createTelegramConsoleNotificationServer,
  createTelegramConsoleRouter,
  createTelegramConsoleSessionStore,
} from "../../src/index.js";

const fixedNow = () => "2026-07-04T10:00:00.000Z";
const noTelegramWaits = Object.freeze({
  limits: Object.freeze({ globalIntervalMs: 0, perChatIntervalMs: 0, groupChatIntervalMs: 0 }),
});

describe("Telegram Console notification intake (G-8)", () => {
  let server: ReturnType<typeof createTelegramConsoleNotificationServer>;
  let telegramApi: ReturnType<typeof createMockTelegramApiAdapter>;
  let baseUrl: string;

  before(async () => {
    telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const sessionStore = createTelegramConsoleSessionStore({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      sessionStore,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });

    // Менеджер привязывает Telegram-аккаунт через /start → сессия в общем store.
    await router.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo", first_name: "Demo" },
        text: "/start",
      },
    });

    const dispatcher = createTelegramConsoleNotificationDispatcher({ router, sessionStore });
    server = createTelegramConsoleNotificationServer({ dispatcher });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a C10 telegram card to the linked manager over POST /internal/notifications/telegram", async () => {
    const response = await fetch(`${baseUrl}/internal/notifications/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notification: notificationFixture() }),
    });

    assert.equal(response.status, 202);
    const result: any = await response.json();
    assert.equal(result.route, "notification:telegram");
    assert.equal(result.status, "delivered");
    assert.equal(result.notification_id, "notif-1");

    const [card] = telegramApi.getSentMessages().slice(-1);
    assert.equal(card.chat_id, 1001);
    assert.match(card.text, /Новое сообщение/);
    assert.match(card.text, /Анна Петрова/);
    assert.ok(Array.isArray(card.reply_markup.inline_keyboard));
  });

  it("skips (no-linked-chat) for a recipient without a linked session", async () => {
    const response = await fetch(`${baseUrl}/internal/notifications/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notification: notificationFixture({ recipient_user_id: "manager-unknown" }),
      }),
    });

    assert.equal(response.status, 202);
    const result: any = await response.json();
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-linked-chat");
  });
});

function notificationFixture(overrides = {}) {
  return {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notif-1",
    organization_id: "org-1",
    recipient_user_id: "manager-1",
    category: "info",
    title: "Новое сообщение",
    body: "Анна Петрова ожидает ответа.",
    payload: { conversation_id: "conv-1", client_id: "client-1" },
    status: "new",
    channels: ["web", "telegram"],
    created_at: "2026-07-03T22:39:00.000Z",
    read_at: null,
    ...overrides,
  };
}
