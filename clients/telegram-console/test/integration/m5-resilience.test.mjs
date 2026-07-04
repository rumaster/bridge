import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TELEGRAM_CONSOLE_CALLBACKS,
  createMockTelegramApiAdapter,
  createMockTelegramConsoleBackendApi,
  createTelegramConsoleRouter,
  createTelegramConsoleSessionStore,
} from "../../src/index.mjs";

const fixedNow = () => "2026-07-04T10:00:00.000Z";
const noTelegramWaits = Object.freeze({
  limits: Object.freeze({
    globalIntervalMs: 0,
    perChatIntervalMs: 0,
    groupChatIntervalMs: 0,
  }),
});

describe("Telegram Console M5 resilience", () => {
  it("retries Backend timeouts with the same idempotency_key and creates no duplicate reply", async () => {
    const waits = [];
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const originalCreate = backendApi.messages.create;
    let firstCreate = true;
    backendApi.messages.create = async (request) => {
      const result = await originalCreate(request);
      if (firstCreate) {
        firstCreate = false;
        const error = new Error("Backend timeout after message commit");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return result;
    };
    const router = createTelegramConsoleRouter({
      telegramApi,
      backendApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
      sleep: async (ms) => waits.push(ms),
      backendRetry: {
        baseDelayMs: 5,
        maxDelayMs: 5,
        maxAttempts: 2,
      },
    });

    await router.handleUpdate(startUpdate());
    await router.handleUpdate(callbackUpdate("reply-prompt", "reply.prompt:conv-1"));
    const reply = await router.handleUpdate(replyUpdate(33));

    assert.equal(reply.route, "message:reply");
    assert.equal(reply.idempotency_key, "tgc-1001-33-conv-1");
    assert.deepEqual(waits, [5]);
    assert.deepEqual(
      backendApi
        .getRecordedRequests()
        .filter((call) => call.method === "POST" && call.path === "/messages")
        .map((call) => call.body.idempotency_key),
      ["tgc-1001-33-conv-1", "tgc-1001-33-conv-1"],
    );
    assert.equal(
      backendApi
        .getFixtures()
        .messages.filter((message) => message.idempotency_key === "tgc-1001-33-conv-1")
        .length,
      1,
    );
  });

  it("restores the active dialog from Backend session state after local state loss", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const sessionStore = createTelegramConsoleSessionStore({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      backendApi,
      sessionStore,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });

    await router.handleUpdate(startUpdate());
    await router.handleUpdate(
      callbackUpdate(
        "reply-prompt",
        `${TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix}conv-1`,
      ),
    );
    sessionStore.clearActiveConversation(1001);

    const reply = await router.handleUpdate(replyUpdate(44));

    assert.equal(reply.route, "message:reply");
    assert.equal(reply.idempotency_key, "tgc-1001-44-conv-1");
    assert.ok(
      backendApi
        .getRecordedRequests()
        .some((call) => call.method === "GET" && call.path === "/telegram-console/active-conversation"),
    );
  });

  it("retries transient Backend session validation without revoking local access", async () => {
    const waits = [];
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const originalGetSession = backendApi.auth.getSession;
    let firstGetSession = true;
    backendApi.auth.getSession = async (request) => {
      if (firstGetSession) {
        firstGetSession = false;
        const error = new Error("temporary auth session outage");
        error.status = 503;
        throw error;
      }
      return originalGetSession(request);
    };
    const router = createTelegramConsoleRouter({
      telegramApi,
      backendApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
      sleep: async (ms) => waits.push(ms),
      backendRetry: {
        baseDelayMs: 7,
        maxDelayMs: 7,
        maxAttempts: 2,
      },
    });

    await router.handleUpdate(startUpdate());
    const dialogs = await router.handleUpdate(dialogsUpdate());

    assert.equal(dialogs.route, "command:dialogs");
    assert.equal(dialogs.status, "ok");
    assert.deepEqual(waits, [7]);
    assert.ok(
      backendApi
        .getRecordedRequests()
        .some((call) => call.method === "GET" && call.path === "/conversations"),
    );
  });

  it("revokes local Telegram access when Backend reports the server session ended", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const router = createTelegramConsoleRouter({
      telegramApi,
      backendApi,
      now: fixedNow,
      telegramDelivery: noTelegramWaits,
    });

    await router.handleUpdate(startUpdate());
    backendApi.auth.revokeSession("mock-manager-session");
    const dialogs = await router.handleUpdate(dialogsUpdate());

    assert.equal(dialogs.route, "command:dialogs");
    assert.equal(dialogs.status, "auth_required");
    assert.match(telegramApi.getSentMessages().at(-1).text, /\/start/);
    assert.equal(
      backendApi
        .getRecordedRequests()
        .some((call) => call.method === "GET" && call.path === "/conversations"),
      false,
    );
  });
});

function startUpdate(username = "manager_demo") {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 1001 },
      from: { id: 501, username, first_name: "Demo" },
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

function dialogsUpdate() {
  return {
    update_id: 4,
    message: {
      message_id: 11,
      chat: { id: 1001 },
      from: { id: 501, username: "manager_demo" },
      text: "/dialogs",
    },
  };
}

function replyUpdate(messageId) {
  return {
    update_id: 3,
    message: {
      message_id: messageId,
      chat: { id: 1001 },
      from: { id: 501, username: "manager_demo" },
      text: "Здравствуйте, проверяю статус заказа.",
    },
  };
}
