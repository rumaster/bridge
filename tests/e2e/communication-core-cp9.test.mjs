import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  createAdapterFailureCoordinator,
  createAiDegradationGuard,
  createCommunicationCoreLoadProbe,
  createCommunicationCoreM1Service,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000951";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T13:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function buildCore() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({
    store,
    clock: createClock(),
  });

  return { core, store };
}

function ingressEnvelope({
  messageId,
  channelId = "web-chat-cp9",
  channelType = "web_chat",
  senderRef = "visitor-cp9",
  conversationRef = "cp9-room",
  text = "CP-9 message",
}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: "2026-07-04T12:59:00.000Z",
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
      occurred_at: "2026-07-04T12:59:00.000Z",
    },
  };
}

describe("E2E CP-9 Communication Core M5: нагрузка и деградация", () => {
  it("принимает нагрузочную партию, деградирует адаптер/AI и продолжает другой канал", async () => {
    const { core, store } = buildCore();
    const probe = createCommunicationCoreLoadProbe({
      core,
      clock: createClock(),
    });
    const messages = Array.from({ length: 24 }, (_item, index) =>
      ingressEnvelope({
        messageId: `30000000-0000-4000-8000-000000009${String(index).padStart(3, "0")}`,
        senderRef: `cp9-load-${index}`,
        conversationRef: "cp9-load-room",
        text: `CP-9 load ${index}`,
      }),
    );

    const report = await probe.runIngressProbe({
      name: "cp9-core-ingress-routing",
      messages,
      concurrency: 6,
    });

    assert.equal(report.total, 24);
    assert.equal(report.accepted, 24);
    assert.equal(report.failed, 0);
    assert.equal(report.duplicates, 0);
    assert.equal(report.concurrency, 6);
    assert.equal(report.peak_in_flight > 1, true);

    const degradedMessage = report.sample_results[0];
    const coordinator = createAdapterFailureCoordinator({
      store,
      adapterClient: {
        async deliver() {
          throw new Error("adapter offline");
        },
      },
      adapter: "web_chat",
      clock: createClock(),
      maxAttempts: 2,
    });
    const ai = createAiDegradationGuard({
      aiClient: {
        async suggest() {
          return new Promise(() => undefined);
        },
      },
      clock: createClock(),
      timeoutMs: 1,
    });

    const adapterResult = await coordinator.deliver({
      organizationId: ORGANIZATION_ID,
      messageId: degradedMessage.message_id,
      delivery: {
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: degradedMessage.message_id,
      },
    });
    const aiResult = await ai.suggest({
      organization_id: ORGANIZATION_ID,
      conversation_id: degradedMessage.conversation_id,
      message_id: degradedMessage.message_id,
    });
    const emailResult = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: "30000000-0000-4000-8000-000000009999",
        channelId: "email-cp9",
        channelType: "email",
        senderRef: "cp9@example.test",
        conversationRef: "cp9-email-thread",
        text: "email channel is still routed",
      }),
    );

    assert.equal(adapterResult.degraded, true);
    assert.equal(adapterResult.status, "failed");
    assert.equal(adapterResult.attempt_count, 2);
    assert.equal(aiResult.degraded, true);
    assert.equal(aiResult.reason, "timeout");
    assert.equal(emailResult.status, "routed");
  });
});
