import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeterministicFbpMock } from "../../../fbp-engine/src/deterministic-fbp.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createFbpWorkflowOutboxPublisher,
} from "../../src/modules/communication-core/communication-core-m1.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const INBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000801";

function createCore() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({
    store,
    clock: () => "2026-07-03T12:00:00.000Z",
  });

  return { core, store };
}

function ingressEnvelope(overrides = {}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: INBOUND_MESSAGE_ID,
    received_at: "2026-07-03T11:59:00.000Z",
    message: {
      message_id: INBOUND_MESSAGE_ID,
      organization_id: ORGANIZATION_ID,
      channel_id: "web-chat-channel",
      channel_type: "web_chat",
      external_message_id: "web-chat-message-1",
      conversation_ref: "web-chat-room-1",
      sender_ref: "visitor-1",
      direction: "inbound",
      content: {
        type: "text",
        text: "Need workflow automation",
      },
      occurred_at: "2026-07-03T11:59:00.000Z",
    },
    ...overrides,
  };
}

describe("Communication Core M3 outbox", () => {
  it("формирует pending outbox события для conversation.created, message.created и message.status_changed", async () => {
    const { core, store } = createCore();

    const accepted = await core.acceptIngressMessage(ingressEnvelope());

    assert.equal(accepted.status, "routed");
    const events = store.getOutboxEvents();
    assert.deepEqual(events.map((event) => event.event_type), [
      "conversation.created",
      "message.created",
      "message.status_changed",
    ]);
    assert.deepEqual(events.map((event) => event.status), [
      "pending",
      "pending",
      "pending",
    ]);
    assert.equal(events[0].aggregate_type, "conversation");
    assert.equal(events[0].aggregate_id, accepted.conversation_id);
    assert.equal(events[0].payload.aggregate_id, accepted.conversation_id);
    assert.equal(events[0].payload.status, "open");
    assert.equal(events[1].aggregate_type, "message");
    assert.equal(events[1].aggregate_id, INBOUND_MESSAGE_ID);
    assert.equal(events[1].payload.aggregate_id, INBOUND_MESSAGE_ID);
    assert.equal(events[1].payload.status, "received");
    assert.equal(events[2].payload.previous_status, "received");
    assert.equal(events[2].payload.status, "routed");

    await core.acceptIngressMessage(ingressEnvelope());
    assert.equal(store.getOutboxEvents().length, 3);
  });

  it("replay публикует pending outbox события идемпотентно", async () => {
    const { core, store } = createCore();
    const delivered = [];
    await core.acceptIngressMessage(ingressEnvelope());

    const first = await core.publishOutboxEvents({
      organizationId: ORGANIZATION_ID,
      publisher: async (event) => {
        delivered.push(event.id);
        return { accepted: true };
      },
    });
    const second = await core.publishOutboxEvents({
      organizationId: ORGANIZATION_ID,
      publisher: async (event) => {
        delivered.push(event.id);
        return { accepted: true };
      },
    });

    assert.equal(first.published_count, 3);
    assert.equal(first.failed_count, 0);
    assert.equal(second.published_count, 0);
    assert.equal(delivered.length, 3);
    assert.deepEqual(
      store.getOutboxEvents().map((event) => event.status),
      ["published", "published", "published"],
    );
  });

  it("replay переводит событие в failed, если publisher отклонил доставку", async () => {
    const { core, store } = createCore();
    await core.acceptIngressMessage(ingressEnvelope());

    const replay = await core.publishOutboxEvents({
      organizationId: ORGANIZATION_ID,
      limit: 1,
      publisher: async () => ({
        accepted: false,
        error: "fbp unavailable",
      }),
    });

    assert.equal(replay.published_count, 0);
    assert.equal(replay.failed_count, 1);
    assert.equal(store.getOutboxEvents()[0].status, "failed");
    assert.equal(store.getOutboxEvents()[0].published_at, null);
  });

  it("FBP publisher не запускает workflow повторно для одного outbox event", async () => {
    const { core, store } = createCore();
    await core.acceptIngressMessage(ingressEnvelope());
    const fbp = createDeterministicFbpMock({
      now: () => "2026-07-03T12:01:00.000Z",
    });
    const publisher = createFbpWorkflowOutboxPublisher({
      fbp,
      workflowId: "workflow-core-domain-events",
      workflowVersionId: "workflow-version-core-domain-events",
      actorUserId: "system",
    });
    const event = store.getOutboxEvents()[1];

    const first = await publisher.publish(event);
    const second = await publisher.publish(event);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(fbp.getMetrics().workflow_start_total, 1);
  });
});
