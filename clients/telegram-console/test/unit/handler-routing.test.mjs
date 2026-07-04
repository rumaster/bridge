import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMockTelegramApiAdapter,
  createMockTelegramConsoleBackendApi,
  createTelegramConsoleRouter,
} from "../../src/index.mjs";

const fixedNow = () => "2026-07-03T22:40:00.000Z";

describe("Telegram Console CP-8 handler routing", () => {
  it("routes /start through C3.auth and stores a linked manager session", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const router = createTelegramConsoleRouter({ telegramApi, backendApi, now: fixedNow });

    const result = await router.handleUpdate(startUpdate());

    assert.equal(result.route, "command:start");
    assert.equal(result.account_link.status, "linked");
    assert.deepEqual(result.account_link.upstream_operations, [
      "POST /auth/login/telegram/start",
      "POST /auth/login/telegram/verify",
    ]);
    assert.deepEqual(
      backendApi.getRecordedRequests().map((request) => `${request.method} ${request.path}`),
      [
        "POST /auth/login/telegram/start",
        "POST /auth/login/telegram/verify",
      ],
    );
    assert.match(telegramApi.getSentMessages()[0].text, /Telegram Console подключена/);
  });

  it("requires account linking before C3.conversations access", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({ telegramApi, now: fixedNow });

    const result = await router.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "/dialogs",
      },
    });

    assert.equal(result.route, "command:dialogs");
    assert.equal(result.status, "auth_required");
    assert.match(telegramApi.getSentMessages()[0].text, /\/start/);
  });

  it("routes /dialogs through C3.conversations after linking", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const router = createTelegramConsoleRouter({ telegramApi, backendApi, now: fixedNow });

    await router.handleUpdate(startUpdate());
    const result = await router.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_demo" },
        text: "/dialogs",
      },
    });

    assert.equal(result.route, "command:dialogs");
    assert.equal(result.status, "ok");
    assert.equal(result.conversations.length, 2);
    assert.match(telegramApi.getSentMessages().at(-1).text, /Активные диалоги/);
    assert.ok(
      backendApi
        .getRecordedRequests()
        .some((request) => request.method === "GET" && request.path === "/conversations"),
    );
  });

  it("keeps auth.link callback as a guided /start entrypoint", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const router = createTelegramConsoleRouter({ telegramApi, now: fixedNow });

    const result = await router.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "callback-1",
        from: { id: 501, username: "manager_demo" },
        message: {
          message_id: 12,
          chat: { id: 1001 },
        },
        data: "auth.link",
      },
    });

    assert.equal(result.route, "callback:auth.link");
    assert.equal(result.status, "ok");
    assert.deepEqual(telegramApi.getAnsweredCallbackQueries(), [
      {
        callback_query_id: "callback-1",
        text: "Откройте /start для привязки аккаунта.",
        show_alert: false,
      },
    ]);
  });
});

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
