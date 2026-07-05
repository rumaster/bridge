import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockBackendApi } from "../../src/backend-client.js";
import { createDeviceRegistry } from "../../src/device-registry.js";
import { createPushDispatcher } from "../../src/push-dispatcher.js";
import { createMockPushProvider } from "../../src/push-provider.js";
import { createRealtimeConsumer } from "../../src/realtime-consumer.js";

let clock = 0;
const now = () => `2026-07-04T12:00:00.${String(clock++).padStart(3, "0")}Z`;

function harness() {
  clock = 0;
  const backend = createMockBackendApi({ now });
  backend.seedClient({ organizationId: "org-1", clientId: "client-1", displayName: "Ada" });
  backend.seedConversation({
    organizationId: "org-1",
    conversationId: "conversation-1",
    clientId: "client-1",
    displayName: "Ada",
  });
  const registry = createDeviceRegistry({ now });
  const provider = createMockPushProvider({ now });
  const pushDispatcher = createPushDispatcher({ provider, registry });
  const consumer = createRealtimeConsumer({ backend, pushDispatcher, registry });
  return { backend, registry, provider, pushDispatcher, consumer };
}

function registerDevice(registry) {
  registry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "device-1",
    platform: "android",
    pushProvider: "fcm",
    pushToken: "token-1",
  });
}

function notificationEvent(eventId = "evt-notification-1") {
  return {
    event: "notification.created",
    event_id: eventId,
    organization_id: "org-1",
    notification: {
      id: "notification-1",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "critical",
      title: "Escalation",
      body: "A client is waiting",
      payload: { conversation_id: "conversation-1" },
      status: "new",
      created_at: "2026-07-04T12:00:00.000Z",
      read_at: null,
    },
  };
}

describe("SVC-MOB realtime-consumer (C7, §19.3/§19.4)", () => {
  it("falls back to push when the recipient has no live WS device", () => {
    const { registry, consumer } = harness();
    registerDevice(registry); // не в онлайне → нет живого WS

    const result = consumer.handleEvent(notificationEvent());
    assert.equal(result.duplicate, false);
    assert.ok(result.pushed, "a push was dispatched");
    assert.equal(result.pushed.results[0].status, "delivered");
    assert.equal(consumer.getMetrics().realtime_push_fallback_total, 1);
    assert.equal(consumer.getMetrics().realtime_ws_delivered_total, 0);
  });

  it("delivers over WS (no push) when the recipient is online", () => {
    const { registry, consumer, provider } = harness();
    registerDevice(registry);
    registry.markOnline("device-1");

    const result = consumer.handleEvent(notificationEvent());
    assert.equal(result.pushed, null, "no push while WS is live");
    assert.equal(consumer.getMetrics().realtime_ws_delivered_total, 1);
    assert.equal(consumer.getMetrics().realtime_push_fallback_total, 0);
    assert.equal(provider.getMetrics().send_total, 0);
  });

  it("deduplicates repeated C7 events by event_id and skips the push", () => {
    const { registry, consumer } = harness();
    registerDevice(registry);

    consumer.handleEvent(notificationEvent("evt-dup"));
    const repeat = consumer.handleEvent(notificationEvent("evt-dup"));

    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.pushed, null);
    assert.equal(consumer.getMetrics().realtime_duplicate_total, 1);
    // Только одна fallback-доставка, несмотря на повтор события.
    assert.equal(consumer.getMetrics().realtime_push_fallback_total, 1);
  });

  it("counts message.created events and projects them into the backend", () => {
    const { backend, consumer } = harness();
    const result = consumer.handleEvent({
      event: "message.created",
      event_id: "evt-message-1",
      organization_id: "org-1",
      occurred_at: "2026-07-04T12:00:00.000Z",
      payload: {
        message_id: "message-1",
        conversation_id: "conversation-1",
        sequence_number: 1,
        sender_type: "client",
        text: "hi",
      },
    });

    assert.equal(result.pushed, null);
    assert.equal(consumer.getMetrics().realtime_message_created_total, 1);
    const stored = backend.listConversationMessages({
      organizationId: "org-1",
      conversationId: "conversation-1",
    });
    assert.deepEqual(stored.map((m) => m.id), ["message-1"]);
  });

  it("counts typing events without producing a push", () => {
    const { consumer } = harness();
    const result = consumer.handleEvent({
      event: "typing.started",
      event_id: "evt-typing-1",
      organization_id: "org-1",
      payload: { conversation_id: "conversation-1" },
    });
    assert.equal(result.pushed, null);
    assert.equal(consumer.getMetrics().realtime_typing_total, 1);
    assert.equal(consumer.getMetrics().realtime_events_total, 1);
  });
});
