import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCommunicationCoreM1Service } from "../../../backend/src/modules/communication-core/index.mjs";
import { createC7RealtimePublisher } from "../../src/c7-realtime-publisher.mjs";
import { createMockWebSocketChannel } from "../../src/mock-ws-channel.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000171";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000271";
const OTHER_CONVERSATION_ID = "10000000-0000-4000-8000-000000000272";
const ENDPOINT_ID = "10000000-0000-4000-8000-000000000371";
const CLIENT_ID = "10000000-0000-4000-8000-000000000471";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000571";

function createCoreWithGateway() {
  const wsChannel = createMockWebSocketChannel();
  const realtimePublisher = createC7RealtimePublisher({
    clock: () => "2026-07-03T12:00:00.000Z",
    wsChannel,
  });
  const core = createCommunicationCoreM1Service({
    clock: () => "2026-07-03T12:00:00.000Z",
    realtimePublisher,
  });

  return { core, wsChannel };
}

function canonicalInboundMessage({
  conversationId = CONVERSATION_ID,
  messageId = MESSAGE_ID,
} = {}) {
  return {
    id: messageId,
    idempotency_key: messageId,
    organization_id: ORGANIZATION_ID,
    conversation_id: conversationId,
    client_id: CLIENT_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: 1,
    type: "text",
    content: {
      text: "Нужна помощь с заказом",
    },
    status: "received",
    created_at: "2026-07-03T11:59:00.000Z",
    updated_at: "2026-07-03T11:59:00.000Z",
  };
}

describe("Backend <-> WebSocket Gateway C7 integration", () => {
  it("delivers Communication Core C7 events to subscribed WebSocket clients", async () => {
    const { core, wsChannel } = createCoreWithGateway();
    const delivered = [];

    wsChannel.connect({
      subscription: {
        organizationId: ORGANIZATION_ID,
        conversationId: CONVERSATION_ID,
      },
      send(event) {
        delivered.push(event);
      },
    });

    await core.acceptIngressMessage(canonicalInboundMessage());

    assert.deepEqual(delivered.map((event) => event.event), [
      "message.created",
      "message.status_changed",
    ]);
    assert.deepEqual(delivered.map((event) => event.sequence_number), [1, 2]);
    assert.equal(delivered[0].organization_id, ORGANIZATION_ID);
    assert.equal(delivered[0].payload.conversation_id, CONVERSATION_ID);
  });

  it("does not leak Core C7 events into another conversation subscription", async () => {
    const { core, wsChannel } = createCoreWithGateway();
    const delivered = [];

    wsChannel.connect({
      subscription: {
        organizationId: ORGANIZATION_ID,
        conversationId: OTHER_CONVERSATION_ID,
      },
      send(event) {
        delivered.push(event);
      },
    });

    await core.acceptIngressMessage(canonicalInboundMessage());

    assert.deepEqual(delivered, []);
  });
});
