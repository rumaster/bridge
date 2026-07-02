import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAccountLinkingDraft } from "../../src/account-linking.mjs";
import { createTelegramConsoleRouter } from "../../src/handler-router.mjs";
import { createMockTelegramApiAdapter } from "../../src/mock-telegram-api.mjs";

describe("Telegram Console M0 handler routing", () => {
  it("routes /start through the C3.auth account-linking draft", async () => {
    const telegramApi = createMockTelegramApiAdapter();
    const router = createTelegramConsoleRouter({
      telegramApi,
      accountLinking: createAccountLinkingDraft(),
    });

    const result = await router.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_one" },
        text: "/start",
      },
    });

    assert.equal(result.route, "command:start");
    assert.equal(result.account_link.status, "draft");
    assert.deepEqual(result.account_link.upstream_operations, [
      "POST /auth/login/telegram/start",
      "POST /auth/login/telegram/verify",
    ]);
    assert.equal(telegramApi.getSentMessages()[0].chat_id, 1001);
  });

  it("keeps /dialogs as an M3-only placeholder", async () => {
    const telegramApi = createMockTelegramApiAdapter();
    const router = createTelegramConsoleRouter({ telegramApi });

    const result = await router.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 1001 },
        from: { id: 501, username: "manager_one" },
        text: "/dialogs",
      },
    });

    assert.equal(result.route, "command:dialogs");
    assert.equal(result.status, "deferred");
    assert.equal(result.deferred_to, "M3");
    assert.equal(result.blocks_m0_gate, false);
    assert.equal(result.blocks_cp1, false);
    assert.match(telegramApi.getSentMessages()[0].text, /M3/);
  });

  it("routes account-link callback buttons to the draft handler", async () => {
    const telegramApi = createMockTelegramApiAdapter();
    const router = createTelegramConsoleRouter({
      telegramApi,
      accountLinking: createAccountLinkingDraft(),
    });

    const result = await router.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "callback-1",
        from: { id: 501, username: "manager_one" },
        message: {
          message_id: 12,
          chat: { id: 1001 },
        },
        data: "auth.link",
      },
    });

    assert.equal(result.route, "callback:auth.link");
    assert.equal(result.account_link.status, "draft");
    assert.deepEqual(telegramApi.getAnsweredCallbackQueries(), [
      {
        callback_query_id: "callback-1",
        text: "Account linking is a C3.auth draft in M0.",
        show_alert: false,
      },
    ]);
  });
});
