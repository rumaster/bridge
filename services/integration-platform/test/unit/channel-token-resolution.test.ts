import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelDeliveryError } from "../../src/delivery/errors.js";
import { createBackendChannelSecretClient } from "../../src/delivery/backend-channel-secret-client.js";
import { createResolvingTelegramClient } from "../../src/delivery/real-channel-clients.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe("backend channel secret client (T2)", () => {
  it("resolves a token and caches it within TTL", async () => {
    let calls = 0;
    const client = createBackendChannelSecretClient({
      baseUrl: "http://backend.test",
      ttlMs: 60_000,
      now: () => 1_000,
      fetchImpl: async (url) => {
        calls += 1;
        assert.match(String(url), /\/internal\/channels\/secret\?organization_id=/);
        return new Response(JSON.stringify({ token: "bot-A" }), { status: 200 });
      },
    });

    assert.equal(await client.resolveToken({ organizationId: ORG_A, channelType: "telegram" }), "bot-A");
    assert.equal(await client.resolveToken({ organizationId: ORG_A, channelType: "telegram" }), "bot-A");
    assert.equal(calls, 1, "second lookup should be served from cache");

    client.invalidate({ organizationId: ORG_A, channelType: "telegram" });
    await client.resolveToken({ organizationId: ORG_A, channelType: "telegram" });
    assert.equal(calls, 2, "invalidation forces a refetch");
  });

  it("returns null on 404 (no connected channel/secret)", async () => {
    const client = createBackendChannelSecretClient({
      baseUrl: "http://backend.test",
      now: () => 0,
      fetchImpl: async () => new Response("", { status: 404 }),
    });

    assert.equal(await client.resolveToken({ organizationId: ORG_A, channelType: "telegram" }), null);
  });

  it("throws a retryable error on transient backend failure", async () => {
    const client = createBackendChannelSecretClient({
      baseUrl: "http://backend.test",
      now: () => 0,
      fetchImpl: async () => new Response("", { status: 503 }),
    });

    await assert.rejects(
      () => client.resolveToken({ organizationId: ORG_A, channelType: "telegram" }),
      (error: unknown) => error instanceof ChannelDeliveryError && error.retryable === true,
    );
  });
});

describe("resolving telegram delivery client (T2)", () => {
  it("delivers via the organization-specific bot token", async () => {
    const tokensByOrg: Record<string, string> = { [ORG_A]: "bot-A", [ORG_B]: "bot-B" };
    const telegramCalls: string[] = [];
    const client = createResolvingTelegramClient({
      baseUrl: "https://telegram.test",
      resolveToken: async ({ organizationId }) => tokensByOrg[organizationId ?? ""] ?? null,
      fetchImpl: async (url) => {
        telegramCalls.push(String(url));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      },
    });

    await client.deliver(telegramDelivery({ organizationId: ORG_A, idempotencyKey: "m-a" }));
    await client.deliver(telegramDelivery({ organizationId: ORG_B, idempotencyKey: "m-b" }));

    assert.equal(telegramCalls[0], "https://telegram.test/botbot-A/sendMessage");
    assert.equal(telegramCalls[1], "https://telegram.test/botbot-B/sendMessage");
  });

  it("fails non-retryably when the organization has no token", async () => {
    const client = createResolvingTelegramClient({
      resolveToken: async () => null,
      fetchImpl: async () => {
        throw new Error("telegram must not be called without a token");
      },
    });

    await assert.rejects(
      () => client.deliver(telegramDelivery({ organizationId: ORG_A, idempotencyKey: "m-a" })),
      (error: unknown) =>
        error instanceof ChannelDeliveryError &&
        error.retryable === false &&
        error.category === "missing_channel_secret",
    );
  });
});

function telegramDelivery({
  organizationId,
  idempotencyKey,
}: {
  organizationId: string;
  idempotencyKey: string;
}) {
  return {
    idempotency_key: idempotencyKey,
    organization_id: organizationId,
    channel_type: "telegram",
    recipient_ref: "chat-1",
    type: "text",
    text: "hello",
    external_payload: { method: "sendMessage", chat_id: "chat-1", text: "hello" },
  };
}
