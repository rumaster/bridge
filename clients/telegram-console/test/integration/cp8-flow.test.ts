import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TELEGRAM_CONSOLE_CALLBACKS,
  createMockTelegramApiAdapter,
  createTelegramConsoleRouter,
} from "../../src/index.js";

const fixedNow = () => "2026-07-03T22:40:00.000Z";
const noTelegramWaits = Object.freeze({
  limits: Object.freeze({
    globalIntervalMs: 0,
    perChatIntervalMs: 0,
    groupChatIntervalMs: 0,
  }),
});

describe("Telegram Console CP-8 flow", () => {
  it("links a manager, lists dialogs and opens history through Backend C3 mocks", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });

    await router.handleUpdate(startUpdate());
    const dialogs = await router.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "/dialogs",
      },
    });

    assert.equal(dialogs.route, "command:dialogs");
    assert.equal(dialogs.status, "ok");
    assert.equal(dialogs.conversations[0].id, "conv-1");

    const opened = await router.handleUpdate(callbackUpdate("callback-open", "dialog.open:conv-1"));

    assert.equal(opened.route, "callback:dialog.open");
    assert.equal(opened.dialog.conversation.id, "conv-1");
    assert.equal(opened.dialog.client.display_name, "Анна Петрова");
    assert.ok(
      opened.dialog.messages.some((message) => message.content.text === "Хочу уточнить статус заказа"),
    );
  });

  it("renders C10 telegram notification cards with CP-8 action buttons", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });
    await router.handleUpdate(startUpdate());

    const result = await router.deliverNotification({
      chatId: 1001,
      notification: {
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
      },
    });

    assert.equal(result.route, "notification:telegram");
    assert.equal(result.status, "delivered");

    const [message] = telegramApi.getSentMessages().slice(-1);
    assert.match(message.text, /Новое сообщение/);
    assert.match(message.text, /Анна Петрова/);
    assert.deepEqual(message.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [
      ["Открыть диалог", "Ответить"],
      ["AI: резюме", "Открыть в Manager Workspace"],
    ]);
  });

  it("requires account linking before notification cards call Backend C3", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });

    const result = await router.deliverNotification({
      chatId: 1001,
      notification: notificationFixture(),
    });

    assert.equal(result.route, "notification:telegram");
    assert.equal(result.status, "auth_required");
    assert.match(telegramApi.getSentMessages()[0].text, /\/start/);
    assert.deepEqual(router.getBackendApi().getRecordedRequests(), []);
  });

  it("sends manager replies through C3.messages with stable idempotency", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });
    await router.handleUpdate(startUpdate());
    await router.handleUpdate(callbackUpdate("callback-reply", "reply.prompt:conv-1"));

    const first = await router.handleUpdate({
      update_id: 3,
      message: {
        message_id: 33,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "Здравствуйте, проверяю статус доставки.",
      },
    });
    const repeated = await router.handleUpdate({
      update_id: 4,
      message: {
        message_id: 33,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "Здравствуйте, проверяю статус доставки.",
      },
    });

    assert.equal(first.route, "message:reply");
    assert.equal(first.message.id, repeated.message.id);
    assert.equal(first.idempotency_key, "tgc-1001-33-conv-1");

    const calls = router.getBackendApi().getRecordedRequests();
    assert.deepEqual(
      calls
        .filter((call) => call.method === "POST" && call.path === "/messages")
        .map((call) => call.body.idempotency_key),
      ["tgc-1001-33-conv-1", "tgc-1001-33-conv-1"],
    );
  });

  it("keeps notifications and replies usable when C4 AI is unavailable", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: fixedNow,
      aiAvailable: false,
      telegramDelivery: noTelegramWaits,
    });
    await router.handleUpdate(startUpdate());
    const ai = await router.handleUpdate(callbackUpdate("callback-ai", "ai.reply:conv-1"));

    assert.equal(ai.route, "callback:ai.reply");
    assert.equal(ai.status, "degraded");
    assert.match(telegramApi.getSentMessages().at(-1).text, /AI недоступен/);

    await router.handleUpdate(callbackUpdate("callback-reply", "reply.prompt:conv-1"));
    const reply = await router.handleUpdate({
      update_id: 5,
      message: {
        message_id: 34,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "Ответ без AI всё равно отправлен.",
      },
    });

    assert.equal(reply.route, "message:reply");
    assert.equal(reply.message.status, "sent");
  });
});

function notificationFixture() {
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
  };
}

function startUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 1001 },
      from: { id: 501, username: "manager_demo", first_name: "Demo" },
      text: "/start",
    },
  };
}

function callbackUpdate(id, data) {
  return {
    update_id: 100,
    callback_query: {
      id,
      from: { id: 501, username: "manager_demo" },
      message: {
        message_id: 12,
        chat: { id: 1001 },
      },
      data,
    },
  };
}
