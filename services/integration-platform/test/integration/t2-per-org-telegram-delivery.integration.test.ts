import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.js";
import {
  createAdapterDeliveryChannel,
  createBackendChannelSecretClient,
  createDeliveryEngine,
  createMockExternalChannel,
  createResolvingTelegramClient,
} from "../../src/delivery/index.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_NO_TOKEN = "33333333-3333-3333-3333-333333333333";

describe("T2 per-organization Telegram egress", () => {
  it("delivers each org's reply through its own bot token, dedups repeats", async () => {
    const telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const engine = createEngine(telegramCalls);

    const a = await engine.deliver(egress({ messageId: "msg-a", organizationId: ORG_A }));
    const b = await engine.deliver(egress({ messageId: "msg-b", organizationId: ORG_B }));
    const dup = await engine.deliver(egress({ messageId: "msg-a", organizationId: ORG_A }));

    assert.equal(a.delivered, true);
    assert.equal(b.delivered, true);
    assert.equal(dup.duplicate, true);

    // Org A → bot-A, Org B → bot-B; повтор idempotency_key не создаёт второй вызов.
    assert.equal(telegramCalls.length, 2);
    assert.equal(telegramCalls[0].url, "https://telegram.test/botbot-A/sendMessage");
    assert.equal(telegramCalls[0].body.chat_id, "chat-1");
    assert.equal(telegramCalls[1].url, "https://telegram.test/botbot-B/sendMessage");
  });

  it("marks delivery failed (not silent noop) when the org has no configured token", async () => {
    const telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const engine = createEngine(telegramCalls);

    const result = await engine.deliver(egress({ messageId: "msg-x", organizationId: ORG_NO_TOKEN }));

    assert.equal(result.delivered, false);
    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.equal(result.error_category, "missing_channel_secret");
    assert.equal(telegramCalls.length, 0);
  });
});

function createEngine(telegramCalls: Array<{ url: string; body: Record<string, unknown> }>) {
  const tokensByOrg: Record<string, string> = { [ORG_A]: "bot-A", [ORG_B]: "bot-B" };

  const secretClient = createBackendChannelSecretClient({
    baseUrl: "http://backend.test",
    now: () => 0,
    fetchImpl: async (url) => {
      const organizationId = new URL(String(url)).searchParams.get("organization_id") ?? "";
      const token = tokensByOrg[organizationId];
      return token
        ? new Response(JSON.stringify({ token }), { status: 200 })
        : new Response("", { status: 404 });
    },
  });

  const telegramClient = createResolvingTelegramClient({
    baseUrl: "https://telegram.test",
    resolveToken: (input) => secretClient.resolveToken(input),
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  });

  const deliveryChannel = createAdapterDeliveryChannel({
    adapters: {
      telegram: createTelegramAdapter({
        channelClient: telegramClient,
        coreIngressUrl: "http://core.test/internal/ingress/messages",
      }),
    },
    fallbackChannel: createMockExternalChannel(),
  });

  return createDeliveryEngine({
    channel: deliveryChannel,
    backendClient: { async recordAttempt() {} },
  });
}

function egress({ messageId, organizationId }: { messageId: string; organizationId: string }) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: "chan-1",
    message: {
      message_id: messageId,
      organization_id: organizationId,
      channel_id: "chan-1",
      channel_type: "telegram",
      direction: "outbound",
      conversation_ref: "chat-1",
      content: { type: "text", text: "hello" },
    },
  };
}
