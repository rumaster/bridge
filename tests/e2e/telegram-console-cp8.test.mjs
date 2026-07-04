import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  createMockTelegramApiAdapter,
  createTelegramConsoleRouter,
} from "../../clients/telegram-console/src/index.mjs";
import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../packages/contracts/src/c10.mjs";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.mjs";

const ORG = "org-1";
const USER = "manager-1";

describe("CP-8 e2e: Telegram Console consumes C10, C3 and C4", () => {
  let notificationServer;
  let notificationBaseUrl;

  before(async () => {
    notificationServer = createNotificationPlatformServer({ now: fixedNow });
    notificationBaseUrl = await listen(notificationServer);
  });

  after(async () => {
    await close(notificationServer);
  });

  it("renders a C10 Telegram card, opens C3 history, requests C4 AI and sends an idempotent reply", async () => {
    const clock = createControllableClock(Date.parse(fixedNow()));
    const telegramApi = createMockTelegramApiAdapter({ now: clock.iso });
    const router = createTelegramConsoleRouter({
      telegramApi,
      now: clock.iso,
      telegramDelivery: {
        now: clock.now,
        sleep: clock.sleep,
        limits: {
          globalIntervalMs: 0,
          perChatIntervalMs: 1_000,
          groupChatIntervalMs: 3_000,
        },
      },
    });

    await router.handleUpdate(startUpdate());
    await enableTelegramNotifications(notificationBaseUrl);
    const accepted = await triggerNotification(notificationBaseUrl);

    assert.equal(accepted.notification.channels.includes("telegram"), true);
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );

    const delivered = await router.deliverNotification({
      chatId: 1001,
      notification: accepted.notification,
    });
    assert.equal(delivered.status, "delivered");
    assert.match(telegramApi.getSentMessages().at(-1).text, /Новое сообщение клиента/);

    const opened = await router.handleUpdate(callbackUpdate("open-1", "dialog.open:conv-1"));
    assert.equal(opened.route, "callback:dialog.open");
    assert.equal(opened.dialog.conversation.id, "conv-1");
    assert.ok(
      opened.dialog.messages.some((message) => message.content.text.includes("статус заказа")),
    );

    const ai = await router.handleUpdate(callbackUpdate("ai-1", "ai.summary:conv-1"));
    assert.equal(ai.route, "callback:ai.summary");
    assert.equal(ai.suggestion.degraded, false);
    assert.match(telegramApi.getSentMessages().at(-1).text, /Применение подсказки выполняется вручную/);

    await router.handleUpdate(callbackUpdate("reply-1", "reply.prompt:conv-1"));
    const reply = await router.handleUpdate({
      update_id: 4,
      message: {
        message_id: 33,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "Здравствуйте, проверяю статус доставки.",
      },
    });

    assert.equal(reply.route, "message:reply");
    assert.equal(reply.message.status, "sent");
    assert.equal(reply.idempotency_key, "tgc-1001-33-conv-1");

    const calls = router.getBackendApi().getRecordedRequests();
    assert.deepEqual(
      calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
      [
        "/auth/login/telegram/start",
        "/auth/login/telegram/verify",
        "/ai/assistant:suggest",
        "/messages",
      ],
    );
    assertPerChatSpacing(telegramApi.getSentMessages(), 1_000);
  });
});

async function enableTelegramNotifications(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/notifications/settings`, {
    method: "PUT",
    headers: headers({ "x-request-id": "req-tgc-settings" }),
    body: JSON.stringify({
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: "req-tgc-settings",
      organization_id: ORG,
      user_id: USER,
      settings: [
        { category: "critical", channel: "web", enabled: true },
        { category: "critical", channel: "telegram", enabled: true },
      ],
    }),
  });

  assert.equal(response.status, 200);
}

async function triggerNotification(baseUrl) {
  const trigger = createNotificationTriggerEvent({
    eventId: "tgc-cp8:notif",
    producerServiceId: "SVC-CORE",
    producerEventId: "message:created:tgc-cp8",
    organizationId: ORG,
    recipientUserId: USER,
    category: "critical",
    title: "Новое сообщение клиента",
    body: "Анна Петрова ожидает ответа менеджера.",
    payload: {
      conversation_id: "conv-1",
      client_id: "client-1",
    },
    dedupeKey: "SVC-CORE:tgc-cp8:message-created",
    occurredAt: fixedNow(),
  });
  const response = await fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(trigger),
  });

  assert.equal(response.status, 202);
  return response.json();
}

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-bridge-organization-id": ORG,
    "x-bridge-user-id": USER,
    ...extra,
  };
}

function fixedNow() {
  return "2026-07-04T10:00:00.000Z";
}

function createControllableClock(start) {
  let current = start;
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function assertPerChatSpacing(messages, minIntervalMs) {
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous.chat_id !== current.chat_id) {
      continue;
    }

    const diff = Date.parse(current.sent_at) - Date.parse(previous.sent_at);
    assert.ok(
      diff >= minIntervalMs,
      `Telegram message ${current.message_id} was sent after ${diff}ms, expected >= ${minIntervalMs}ms`,
    );
  }
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
    update_id: 2,
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
