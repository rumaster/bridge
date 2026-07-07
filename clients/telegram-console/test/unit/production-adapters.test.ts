import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TelegramBotApiError,
  createTelegramBotApiAdapter,
  createTelegramConsoleBackendApiClient,
  createTelegramLongPollingRunner,
} from "../../src/index.js";

const ORG = "00000000-0000-4000-8000-000000000101";
const USER = "00000000-0000-4000-8000-000000000201";
const CONVERSATION = "00000000-0000-4000-8000-000000000501";
const CLIENT = "00000000-0000-4000-8000-000000000301";
const ENDPOINT = "00000000-0000-4000-8000-000000000401";

describe("Telegram Console production adapters", () => {
  it("maps router calls to real Backend REST C3/C4/C10 endpoints", async () => {
    const calls: any[] = [];
    const client = createTelegramConsoleBackendApiClient({
      baseUrl: "https://backend.bridge.local/api/v1",
      fetcher: async (input: any, init: any = {}) => {
        const url = String(input);
        const headers = new Headers(init.headers);
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init.method ?? "GET", headers, body });

        if (url.endsWith("/auth/login/telegram/start")) {
          assert.equal(body.telegramUsername, "manager_demo");
          return jsonResponse({
            requestId: "login-request-1",
            delivery: "telegram",
            expiresAt: "2026-07-07T12:05:00.000Z",
          });
        }
        if (url.endsWith("/auth/login/telegram/verify")) {
          assert.equal(body.requestId, "login-request-1");
          assert.equal(body.code, "123456");
          return jsonResponse(sessionFixture());
        }
        if (url.endsWith("/auth/session")) {
          assert.equal(headers.get("authorization"), "Bearer session-token-1");
          assert.equal(headers.get("x-organization-id"), ORG);
          return jsonResponse(sessionFixture());
        }
        if (url.endsWith("/conversations")) {
          assert.equal(headers.get("authorization"), "Bearer session-token-1");
          assert.equal(headers.get("x-organization-id"), ORG);
          return jsonResponse({
            items: [
              {
                id: CONVERSATION,
                organizationId: ORG,
                clientId: CLIENT,
                status: "open",
                lastMessageAt: "2026-07-07T12:00:00.000Z",
                createdAt: "2026-07-07T11:50:00.000Z",
                updatedAt: "2026-07-07T12:00:00.000Z",
              },
            ],
            page: { limit: 50, total: 1 },
          });
        }
        if (url.endsWith(`/clients/${CLIENT}`)) {
          return jsonResponse({
            id: CLIENT,
            organizationId: ORG,
            displayName: "Анна Петрова",
            status: "offline",
            tags: ["telegram"],
            notes: [],
            endpoints: [
              {
                id: ENDPOINT,
                channel: "telegram",
                externalId: "telegram:anna",
                displayName: "@anna",
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${CONVERSATION}/messages`)) {
          return jsonResponse({
            items: [
              {
                id: "00000000-0000-4000-8000-000000000601",
                organizationId: ORG,
                conversationId: CONVERSATION,
                endpointId: ENDPOINT,
                channel: "telegram",
                direction: "inbound",
                senderType: "client",
                sequenceNumber: 1,
                type: "text",
                content: { text: "Здравствуйте" },
                status: "received",
                createdAt: "2026-07-07T11:59:00.000Z",
                deliveredAt: null,
              },
            ],
            page: { limit: 50, total: 1 },
          });
        }
        if (url.endsWith("/messages")) {
          assert.equal(init.method, "POST");
          assert.equal(headers.get("authorization"), "Bearer session-token-1");
          assert.equal(headers.get("x-organization-id"), ORG);
          assert.equal(headers.get("x-actor-user-id"), USER);
          assert.equal(headers.get("idempotency-key"), "tgc-1001-33-conversation");
          assert.deepEqual(body, {
            conversationId: CONVERSATION,
            endpointId: ENDPOINT,
            direction: "outbound",
            senderType: "manager",
            type: "text",
            content: { text: "Проверяю статус" },
          });
          return jsonResponse(
            {
              id: "00000000-0000-4000-8000-000000000701",
              organizationId: ORG,
              conversationId: CONVERSATION,
              endpointId: ENDPOINT,
              channel: "telegram",
              direction: "outbound",
              senderType: "manager",
              sequenceNumber: 2,
              type: "text",
              content: { text: "Проверяю статус" },
              status: "routed",
              createdAt: "2026-07-07T12:01:00.000Z",
              deliveredAt: null,
            },
            201,
          );
        }

        throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
      },
    });

    const start: any = await client.auth.startTelegramLogin({
      telegram_username: "manager_demo",
    });
    const session: any = await client.auth.verifyTelegramLogin({
      request_id: start.request_id,
      code: "123456",
      telegram_username: "manager_demo",
    });
    await client.withSession(session, async () => {
      assert.deepEqual(await client.auth.getSession({ token: session.token }), sessionFixture(true));
      const conversations = await client.conversations.list();
      assert.equal(conversations[0].id, CONVERSATION);
      assert.equal(conversations[0].client_id, CLIENT);
      assert.equal(conversations[0].unread_count, 0);
      assert.equal((await client.clients.get(CLIENT)).display_name, "Анна Петрова");
      assert.equal((await client.conversations.listMessages(CONVERSATION))[0].endpoint_id, ENDPOINT);
      const message = await client.messages.create({
        idempotency_key: "tgc-1001-33-conversation",
        organization_id: ORG,
        conversation_id: CONVERSATION,
        sender_type: "manager",
        type: "text",
        content: { text: "Проверяю статус" },
      });
      assert.equal(message.conversation_id, CONVERSATION);
      assert.equal(message.idempotency_key, "tgc-1001-33-conversation");
    });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
      [
        "POST /api/v1/auth/login/telegram/start",
        "POST /api/v1/auth/login/telegram/verify",
        "GET /api/v1/auth/session",
        "GET /api/v1/conversations",
        `GET /api/v1/clients/${CLIENT}`,
        `GET /api/v1/conversations/${CONVERSATION}/messages`,
        "POST /api/v1/messages",
      ],
    );
  });

  it("uses Telegram Bot API sendMessage/answerCallbackQuery/getUpdates over HTTPS JSON", async () => {
    const calls: any[] = [];
    const telegram = createTelegramBotApiAdapter({
      token: "123456:secret",
      apiBaseUrl: "https://telegram.local",
      fetcher: async (input: any, init: any = {}) => {
        const url = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init.method, body });

        if (url.endsWith("/sendMessage")) {
          return jsonResponse({
            ok: true,
            result: { message_id: 10, chat: { id: body.chat_id }, text: body.text },
          });
        }
        if (url.endsWith("/answerCallbackQuery")) {
          return jsonResponse({ ok: true, result: true });
        }
        if (url.endsWith("/getUpdates")) {
          return jsonResponse({
            ok: true,
            result: [{ update_id: 42, message: { message_id: 1, chat: { id: 1001 }, text: "/help" } }],
          });
        }

        return jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 2 },
          },
          429,
        );
      },
    });

    const sent = await telegram.sendMessage({ chat_id: 1001, text: "hello" });
    assert.equal(sent.message_id, 10);
    assert.equal(await telegram.answerCallbackQuery({ callback_query_id: "cb-1" }), true);
    assert.equal((await telegram.getUpdates({ offset: 41, timeout: 1 }))[0].update_id, 42);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
      [
        "POST /bot123456:secret/sendMessage",
        "POST /bot123456:secret/answerCallbackQuery",
        "POST /bot123456:secret/getUpdates",
      ],
    );
  });

  it("turns Telegram API errors into retryable errors with retry_after metadata", async () => {
    const telegram = createTelegramBotApiAdapter({
      token: "123456:secret",
      apiBaseUrl: "https://telegram.local",
      fetcher: async () =>
        jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 3 },
          },
          429,
        ),
    });

    await assert.rejects(
      () => telegram.sendMessage({ chat_id: 1001, text: "hello" }),
      (error: any) => {
        assert.ok(error instanceof TelegramBotApiError);
        assert.equal(error.status, 429);
        assert.equal(error.parameters.retry_after, 3);
        return true;
      },
    );
  });

  it("polls getUpdates and advances offset after handled updates", async () => {
    const handled: any[] = [];
    const telegramApi = {
      requests: [] as any[],
      async getUpdates(request: any) {
        this.requests.push(request);
        return this.requests.length === 1
          ? [{ update_id: 10, message: { message_id: 1, chat: { id: 1001 }, text: "/help" } }]
          : [];
      },
    };
    const router = {
      async handleUpdate(update: any) {
        handled.push(update);
        return { route: "test", status: "ok" };
      },
    };
    const runner = createTelegramLongPollingRunner({
      telegramApi,
      router,
      pollTimeoutSeconds: 1,
      logger: null,
    });

    assert.equal(await runner.pollOnce(), 1);
    assert.equal(await runner.pollOnce(), 0);
    assert.deepEqual(telegramApi.requests, [
      { offset: undefined, timeout: 1, allowed_updates: ["message", "callback_query"] },
      { offset: 11, timeout: 1, allowed_updates: ["message", "callback_query"] },
    ]);
    assert.equal(handled[0].update_id, 10);
  });
});

function sessionFixture(normalized = false) {
  if (normalized) {
    return {
      token: "session-token-1",
      user: {
        id: USER,
        display_name: "Демо Менеджер",
        role: "manager",
        telegram_username: "manager_demo",
      },
      organization: { id: ORG, name: "Bridge Demo" },
      expires_at: "2026-07-07T20:00:00.000Z",
      revoked_at: null,
    };
  }

  return {
    token: "session-token-1",
    user: {
      id: USER,
      displayName: "Демо Менеджер",
      role: "manager",
      telegramUsername: "manager_demo",
    },
    organization: { id: ORG, name: "Bridge Demo" },
    expiresAt: "2026-07-07T20:00:00.000Z",
    revokedAt: null,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
