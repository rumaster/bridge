import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TELEGRAM_CONSOLE_CALLBACKS,
  createMockTelegramApiAdapter,
  createMockTelegramConsoleBackendApi,
  createTelegramConsoleRouter,
} from "../../clients/telegram-console/src/index.mjs";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readContract() {
  return readJson("packages/contracts/consumer/telegram-console-cp8.consumer.v1.json");
}

describe("SVC-TGC CP-8 Telegram Console consumer contract", () => {
  it("publishes the CP-8/M4 consumer contract for C3.auth, C3, C4 and C10", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "CP8.telegram-console.consumer");
    assert.equal(contract["x-consumer"], "SVC-TGC");
    assert.equal(contract["x-stage"], "M4");
    assert.deepEqual(contract.upstream_contracts, ["C3.auth", "C3", "C4", "C10"]);
    assert.deepEqual(contract.out_of_scope.deferred_to_m5, [
      "telegram rate limits",
      "mass notification throttling",
    ]);
  });

  it("uses published C3.auth login endpoints and stores a server session", () => {
    const contract = readContract();
    const authOpenApi = readJson("packages/contracts/openapi/auth/c3.auth.openapi.json");

    const start = findInteraction(contract, "POST", "/auth/login/telegram/start");
    const verify = findInteraction(contract, "POST", "/auth/login/telegram/verify");

    assert.equal(authOpenApi.paths[start.path].post.operationId, start.operationId);
    assert.equal(authOpenApi.paths[verify.path].post.operationId, verify.operationId);
    assert.deepEqual(start.request.required, ["telegramUsername"]);
    assert.deepEqual(verify.request.required, ["code"]);
    assert.equal(verify.response.consumer_behavior.storeServerSessionByTelegramChat, true);
    assert.equal(verify.response.consumer_behavior.requireSessionForBackendCalls, true);
  });

  it("uses the published C3 conversation, client and message endpoint set", () => {
    const contract = readContract();
    const backendOpenApi = readJson("packages/contracts/openapi/backend-core/openapi.json");

    const consumed = contract.interactions.filter((interaction) => interaction.contract === "C3");
    for (const interaction of consumed) {
      const publishedPath = `/api/v1${interaction.path.replace(
        "{conversationId}",
        "{id}",
      ).replace("{clientId}", "{id}")}`;
      const operation = backendOpenApi.paths[publishedPath]?.[interaction.method.toLowerCase()];

      assert.ok(operation, `${interaction.method} ${publishedPath} is not published`);
      assert.equal(operation.operationId, interaction.operationId);
    }

    const createMessage = findInteraction(contract, "POST", "/messages");
    assert.deepEqual(createMessage.request.required, [
      "idempotency_key",
      "organization_id",
      "conversation_id",
      "sender_type",
      "type",
      "content.text",
    ]);
    assert.equal(createMessage.idempotency.keyField, "idempotency_key");
    assert.equal(createMessage.idempotency.repeatReturnsSameMessage, true);
  });

  it("consumes C10 telegram notifications as bot cards with CP-8 actions", () => {
    const contract = readContract();
    const c10OpenApi = readJson("packages/contracts/openapi/notifications/c10.notifications.openapi.json");
    const notification = contract.interactions.find(
      (interaction) => interaction.contract === "C10",
    );

    assert.ok(notification);
    assert.deepEqual(
      notification.notification.required,
      c10OpenApi.components.schemas.Notification.required,
    );
    assert.ok(
      c10OpenApi.components.schemas.NotificationChannel.enum.includes("telegram"),
      "C10.NotificationChannel must publish telegram",
    );

    const notificationFields = Object.keys(
      c10OpenApi.components.schemas.Notification.properties,
    );
    for (const field of notification.notification.consumed_fields) {
      assert.ok(notificationFields.includes(field), `${field} is not published`);
    }
    assert.deepEqual(notification.notification.actions, [
      "open_dialog",
      "reply",
      "ai_summary",
      "open_manager_workspace",
    ]);
  });

  it("consumes C4 assistant suggestions with manual application and graceful degradation", () => {
    const contract = readContract();
    const c4OpenApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const suggest = findInteraction(contract, "POST", "/ai/assistant:suggest");

    assert.deepEqual(
      suggest.request.required,
      c4OpenApi.components.schemas.AssistantSuggestRequest.required,
    );
    assert.deepEqual(
      suggest.response.required,
      c4OpenApi.components.schemas.AssistantSuggestResponse.required,
    );
    assert.equal(suggest.response.manualApplyOnly, true);
    assert.deepEqual(suggest.response.modes, ["summary", "reply", "kb", "translate"]);
    assert.equal(suggest.degradation.aiUnavailableKeepsNotificationsUsable, true);
    assert.equal(suggest.degradation.aiUnavailableKeepsRepliesUsable, true);
  });

  it("keeps callback names in sync with the Telegram Console router", () => {
    const contract = readContract();
    const callbackNames = contract.telegram_callbacks.map((item) => item.callback_data);

    assert.deepEqual(callbackNames, [
      TELEGRAM_CONSOLE_CALLBACKS.listDialogs,
      `${TELEGRAM_CONSOLE_CALLBACKS.openDialogPrefix}{conversationId}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix}{conversationId}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.quickReplyPrefix}{conversationId}:{template}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.aiSummaryPrefix}{conversationId}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.aiReplyPrefix}{conversationId}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.aiKbPrefix}{conversationId}`,
      `${TELEGRAM_CONSOLE_CALLBACKS.aiTranslatePrefix}{conversationId}`,
    ]);
  });

  it("proves idempotent reply behavior against the SVC-TGC Backend mock", async () => {
    const telegramApi = createMockTelegramApiAdapter({ now: fixedNow });
    const backendApi = createMockTelegramConsoleBackendApi({ now: fixedNow });
    const router = createTelegramConsoleRouter({ telegramApi, backendApi, now: fixedNow });

    await router.handleUpdate(startUpdate());
    await router.handleUpdate(callbackUpdate("reply-prompt", "reply.prompt:conv-1"));
    const first = await router.handleUpdate(replyUpdate(33));
    const repeated = await router.handleUpdate(replyUpdate(33));

    assert.equal(first.message.id, repeated.message.id);
    assert.equal(first.idempotency_key, "tgc-1001-33-conv-1");
  });
});

function findInteraction(contract, method, path) {
  const interaction = contract.interactions.find(
    (item) => item.method === method && item.path === path,
  );
  assert.ok(interaction, `${method} ${path} interaction is missing`);
  return interaction;
}

function fixedNow() {
  return "2026-07-04T10:00:00.000Z";
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
