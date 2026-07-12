import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMaxAdapter } from "../../src/adapters/max/max-adapter.js";
import {
  createAdapterDeliveryChannel,
  createBackendChannelSecretClient,
  createDeliveryEngine,
  createMockExternalChannel,
  createResolvingMaxClient,
} from "../../src/delivery/index.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_NO_TOKEN = "33333333-3333-3333-3333-333333333333";

describe("M2 per-organization MAX egress", () => {
  it("delivers each org's reply through its own bot token, dedups repeats", async () => {
    const maxCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const engine = createEngine(maxCalls);

    const a = await engine.deliver(egress({ messageId: "msg-a", organizationId: ORG_A }));
    const b = await engine.deliver(egress({ messageId: "msg-b", organizationId: ORG_B }));
    const dup = await engine.deliver(egress({ messageId: "msg-a", organizationId: ORG_A }));

    assert.equal(a.delivered, true);
    assert.equal(b.delivered, true);
    assert.equal(dup.duplicate, true);

    // Org A → max-A, Org B → max-B; повтор idempotency_key не создаёт второй вызов.
    assert.equal(maxCalls.length, 2);
    assert.equal(maxCalls[0].url, "https://max.test/messages?access_token=max-A&chat_id=chat-1");
    assert.deepEqual(maxCalls[0].body, { text: "hello" });
    assert.equal(maxCalls[1].url, "https://max.test/messages?access_token=max-B&chat_id=chat-1");
  });

  it("marks delivery failed (not silent noop) when the org has no configured token", async () => {
    const maxCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const engine = createEngine(maxCalls);

    const result = await engine.deliver(egress({ messageId: "msg-x", organizationId: ORG_NO_TOKEN }));

    assert.equal(result.delivered, false);
    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.equal(result.error_category, "missing_channel_secret");
    assert.equal(maxCalls.length, 0);
  });
});

function createEngine(maxCalls: Array<{ url: string; body: Record<string, unknown> }>) {
  const tokensByOrg: Record<string, string> = { [ORG_A]: "max-A", [ORG_B]: "max-B" };

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

  const maxClient = createResolvingMaxClient({
    baseUrl: "https://max.test",
    resolveToken: (input) => secretClient.resolveToken(input),
    fetchImpl: async (url, init) => {
      maxCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ message: { body: { mid: "mid-1" } } }), { status: 200 });
    },
  });

  const deliveryChannel = createAdapterDeliveryChannel({
    adapters: {
      max: createMaxAdapter({
        channelClient: maxClient,
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
      channel_type: "max",
      direction: "outbound",
      conversation_ref: "chat-1",
      content: { type: "text", text: "hello" },
    },
  };
}
