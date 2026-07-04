import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  assertStatusTransition,
  createAdapterFailureCoordinator,
  createAiDegradationGuard,
  createCommunicationCoreLoadProbe,
  createCommunicationCoreM1Service,
} from "../../src/modules/communication-core/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T10:30:00.${String(tick++).padStart(3, "0")}Z`;
}

function createCore() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({
    store,
    clock: createClock(),
  });

  return { core, store };
}

function ingressEnvelope({
  messageId,
  channelId = "web-chat-m5",
  channelType = "web_chat",
  senderRef = "visitor-m5",
  conversationRef = "m5-room",
  text = "M5 message",
}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: "2026-07-04T10:00:00.000Z",
    message: {
      message_id: messageId,
      organization_id: ORGANIZATION_ID,
      channel_id: channelId,
      channel_type: channelType,
      external_message_id: messageId,
      conversation_ref: conversationRef,
      sender_ref: senderRef,
      direction: "inbound",
      content: {
        type: "text",
        text,
      },
      occurred_at: "2026-07-04T10:00:00.000Z",
    },
  };
}

describe("Communication Core M5 — деградация и нагрузочные пробники", () => {
  it("разрешает статусную цепочку отказа received -> routed -> failed", () => {
    assert.equal(assertStatusTransition("received", "routed"), true);
    assert.equal(assertStatusTransition("routed", "failed"), true);
    assert.equal(assertStatusTransition("failed", "routed"), false);
  });

  it("фиксирует отказ адаптера retry-журналом и финальным status=failed", async () => {
    const { core, store } = createCore();
    const accepted = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: "30000000-0000-4000-8000-000000000501",
      }),
    );
    assert.equal(accepted.status, "routed");

    let calls = 0;
    const adapterClient = {
      async deliver() {
        calls += 1;
        return { accepted: false, error: `adapter unavailable ${calls}` };
      },
    };
    const coordinator = createAdapterFailureCoordinator({
      store,
      adapterClient,
      adapter: "web_chat",
      clock: createClock(),
      maxAttempts: 2,
    });

    const result = await coordinator.deliver({
      organizationId: ORGANIZATION_ID,
      messageId: accepted.message_id,
      delivery: {
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: accepted.message_id,
      },
    });

    assert.equal(result.delivered, false);
    assert.equal(result.degraded, true);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "adapter_rejected");
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(
      store.getDeliveryAttempts().map((attempt) => attempt.status),
      ["failed", "failed"],
    );

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: accepted.conversation_id,
    });
    assert.equal(messages.data[0].status, "failed");
  });

  it("не блокирует приём других каналов, пока один адаптер деградирует по timeout", async () => {
    const { core, store } = createCore();
    const stuck = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: "30000000-0000-4000-8000-000000000502",
      }),
    );
    const coordinator = createAdapterFailureCoordinator({
      store,
      adapterClient: {
        async deliver() {
          return new Promise(() => undefined);
        },
      },
      adapter: "web_chat",
      clock: createClock(),
      maxAttempts: 1,
      timeoutMs: 1,
    });

    const failingDelivery = coordinator.deliver({
      organizationId: ORGANIZATION_ID,
      messageId: stuck.message_id,
      delivery: {
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: stuck.message_id,
      },
    });
    const otherChannel = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: "30000000-0000-4000-8000-000000000503",
        channelId: "email-m5",
        channelType: "email",
        senderRef: "client@example.test",
        conversationRef: "email-thread-m5",
        text: "email still accepted",
      }),
    );
    const degraded = await failingDelivery;

    assert.equal(otherChannel.status, "routed");
    assert.equal(degraded.reason, "timeout");
    assert.equal(degraded.status, "failed");
  });

  it("возвращает AI fallback при недоступном AI без исключения в ядро", async () => {
    const guard = createAiDegradationGuard({
      aiClient: {
        async suggest() {
          throw new Error("ai platform unavailable");
        },
      },
      clock: createClock(),
      fallback: (_request, reason) => ({
        contract: "C4.AiAssistantSuggestResponse",
        degraded: true,
        reason,
        suggestions: [],
      }),
    });

    const result = await guard.suggest({
      organization_id: ORGANIZATION_ID,
      conversation_id: "20000000-0000-4000-8000-000000000501",
      message_id: "30000000-0000-4000-8000-000000000504",
    });

    assert.equal(result.degraded, true);
    assert.equal(result.reason, "error");
    assert.equal(result.response.contract, "C4.AiAssistantSuggestResponse");
    assert.deepEqual(result.response.suggestions, []);
  });

  it("фиксирует измерения load probe для приёма и маршрутизации", async () => {
    const { core } = createCore();
    const probe = createCommunicationCoreLoadProbe({
      core,
      clock: createClock(),
    });
    const messages = Array.from({ length: 12 }, (_item, index) =>
      ingressEnvelope({
        messageId: `30000000-0000-4000-8000-0000000006${String(index).padStart(2, "0")}`,
        senderRef: `load-${index}`,
        conversationRef: `load-room-${index}`,
        text: `load ${index}`,
      }),
    );

    const report = await probe.runIngressProbe({
      messages,
      concurrency: 4,
    });

    assert.equal(report.total, 12);
    assert.equal(report.accepted, 12);
    assert.equal(report.failed, 0);
    assert.equal(report.duplicates, 0);
    assert.equal(report.peak_in_flight >= 1, true);
    assert.equal(report.throughput_per_second > 0, true);
    assert.equal(report.latency_ms.p95 >= 0, true);
  });
});
