import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createEmailHttpGatewayClient,
  createMaxBotApiClient,
  createRealChannelClientsFromEnv,
  createTelegramBotApiClient,
} from "../../src/delivery/real-channel-clients.js";

describe("real channel delivery clients", () => {
  it("Telegram Bot API client sends formatted payload with idempotency key", async () => {
    const calls = [];
    const client = createTelegramBotApiClient({
      baseUrl: "https://telegram.test",
      fetchImpl: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 42 },
          }),
          { status: 200 },
        );
      },
      token: "bot-token",
    });

    const result = await client.deliver({
      idempotency_key: "idem-telegram-1",
      external_payload: {
        chat_id: "chat-1",
        method: "sendMessage",
        text: "hello telegram",
      },
    });

    assert.equal(calls[0].url, "https://telegram.test/botbot-token/sendMessage");
    assert.deepEqual(calls[0].body, {
      chat_id: "chat-1",
      text: "hello telegram",
    });
    assert.equal(calls[0].headers["x-idempotency-key"], "idem-telegram-1");
    assert.equal(result.external_message_id, "42");
    assert.equal(result.provider, "telegram");
  });

  it("Email HTTP client posts external payload to the configured gateway", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({
        body: JSON.parse(String(init.body)),
        headers: init.headers,
        url: String(url),
      });
      return new Response(JSON.stringify({ external_message_id: `${calls.length}` }), {
        status: 202,
      });
    };

    const email = createEmailHttpGatewayClient({
      fetchImpl,
      token: "email-token",
      url: "https://email-gateway.test/deliver",
    });

    const emailResult = await email.deliver({
      idempotency_key: "idem-email-1",
      external_payload: { recipient: "user@example.test", text: "hello email" },
    });

    assert.equal(calls[0].url, "https://email-gateway.test/deliver");
    assert.equal(calls[0].headers.authorization, "Bearer email-token");
    assert.equal(calls[0].headers["x-idempotency-key"], "idem-email-1");
    assert.deepEqual(calls[0].body, {
      recipient: "user@example.test",
      text: "hello email",
    });
    assert.equal(emailResult.external_message_id, "1");
  });

  it("MAX Bot API client posts to /messages with chat_id query and returns mid (M2)", async () => {
    const calls = [];
    const client = createMaxBotApiClient({
      baseUrl: "https://max.test",
      fetchImpl: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          headers: init.headers,
          url: String(url),
        });
        return new Response(JSON.stringify({ message: { body: { mid: "mid-77" } } }), {
          status: 200,
        });
      },
      token: "max-token",
    });

    const result = await client.deliver({
      idempotency_key: "idem-max-1",
      recipient_ref: "max-chat-1",
      external_payload: { chat_id: "max-chat-1", text: "hello max" },
    });

    assert.equal(calls[0].url, "https://max.test/messages?access_token=max-token&chat_id=max-chat-1");
    assert.deepEqual(calls[0].body, { text: "hello max" });
    assert.equal(calls[0].headers["x-idempotency-key"], "idem-max-1");
    assert.equal(result.external_message_id, "mid-77");
    assert.equal(result.provider, "max");
  });

  it("builds only configured real clients from environment (email/MAX are not built here)", () => {
    const clients = createRealChannelClientsFromEnv({
      EMAIL_DELIVERY_URL: "https://email-gateway.test/deliver",
      TELEGRAM_BOT_TOKEN: "telegram-token",
    } as NodeJS.ProcessEnv) as { telegram?: unknown; email?: unknown; max?: unknown };

    assert.equal(typeof (clients.telegram as { deliver?: unknown })?.deliver, "function");
    // Email — Edge-owned (SMTP на Edge, E4); MAX — реальный Bot API per-org (M2).
    // Оба не собираются этой env-фабрикой.
    assert.equal(clients.email, undefined);
    assert.equal(clients.max, undefined);
  });
});
