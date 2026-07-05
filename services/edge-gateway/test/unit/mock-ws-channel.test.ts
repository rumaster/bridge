import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWebSocketEvent } from "../../../../packages/contracts/src/c7.js";
import {
  createInMemoryC7EventBus,
  createInMemoryC7EventStore,
  createMockWebSocketChannel,
} from "../../src/mock-ws-channel.js";

interface MakeEventOverrides {
  eventId?: string;
  organizationId?: string;
  event?: string;
  sequenceNumber?: number;
  conversationId?: string;
  endpointId?: string;
  clientId?: string;
  payload?: Record<string, unknown>;
  subscriptionId?: string;
}

function makeEvent(index, overrides: MakeEventOverrides = {}) {
  return createWebSocketEvent({
    eventId: overrides.eventId ?? `event-${index}`,
    organizationId: overrides.organizationId ?? "org-1",
    event: overrides.event ?? "message.created",
    sequenceNumber: overrides.sequenceNumber ?? index,
    payload: {
      message_id: `message-${index}`,
      conversation_id: overrides.conversationId ?? "conversation-1",
      endpoint_id: overrides.endpointId ?? "endpoint-1",
      client_id: overrides.clientId ?? "client-1",
      ...(overrides.payload ?? {}),
    },
    occurredAt: "2026-07-02T16:20:00.000Z",
    subscriptionId: overrides.subscriptionId,
  });
}

describe("Mock C7 WebSocket channel", () => {
  it("replays only events after last_event_id on reconnect", () => {
    const channel = createMockWebSocketChannel({
      initialEvents: [makeEvent(1), makeEvent(2), makeEvent(3)],
    });
    const delivered = [];

    const connection = channel.connect({
      lastEventId: "event-1",
      send(event) {
        delivered.push(event.event_id);
      },
    });

    assert.deepEqual(delivered, ["event-2", "event-3"]);
    assert.equal(connection.lastEventId, "event-3");
    connection.close();
  });

  it("routes events only to matching subscription filters", () => {
    const channel = createMockWebSocketChannel();
    const conversationOne = [];
    const conversationTwo = [];
    const organizationWide = [];

    channel.connect({
      subscription: {
        organizationId: "org-1",
        conversationId: "conversation-1",
      },
      send(event) {
        conversationOne.push(event.event_id);
      },
    });
    channel.connect({
      subscription: {
        organizationId: "org-1",
        conversationId: "conversation-2",
      },
      send(event) {
        conversationTwo.push(event.event_id);
      },
    });
    channel.connect({
      subscription: {
        organizationId: "org-1",
      },
      send(event) {
        organizationWide.push(event.event_id);
      },
    });

    channel.publish(makeEvent(1, { conversationId: "conversation-1" }));

    assert.deepEqual(conversationOne, ["event-1"]);
    assert.deepEqual(conversationTwo, []);
    assert.deepEqual(organizationWide, ["event-1"]);
  });

  it("replays by after_sequence_number without redelivering already observed events", () => {
    const channel = createMockWebSocketChannel({
      initialEvents: [
        makeEvent(1, { conversationId: "conversation-1" }),
        makeEvent(2, { conversationId: "conversation-1" }),
        makeEvent(3, { conversationId: "conversation-2" }),
        makeEvent(4, { conversationId: "conversation-1" }),
      ],
    });
    const delivered = [];

    channel.connect({
      afterSequenceNumber: 2,
      subscription: {
        organizationId: "org-1",
        conversationId: "conversation-1",
      },
      send(event) {
        delivered.push(event.event_id);
      },
    });

    assert.deepEqual(delivered, ["event-4"]);
  });

  it("deduplicates events by event_id", () => {
    const channel = createMockWebSocketChannel();
    const first = channel.publish(makeEvent(1));
    const duplicate = channel.publish(makeEvent(1));

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(channel.getEvents().map((event) => event.event_id), ["event-1"]);
  });

  it("delivers events across gateway instances through a shared C7 hub", () => {
    const eventStore = createInMemoryC7EventStore();
    const eventBus = createInMemoryC7EventBus();
    const gatewayA = createMockWebSocketChannel({ eventBus, eventStore });
    const gatewayB = createMockWebSocketChannel({ eventBus, eventStore });
    const deliveredOnB = [];

    gatewayB.connect({
      subscription: {
        organizationId: "org-1",
      },
      send(event) {
        deliveredOnB.push(event.event_id);
      },
    });

    gatewayA.publish(makeEvent(1));

    assert.deepEqual(deliveredOnB, ["event-1"]);
    assert.deepEqual(gatewayB.getEvents().map((event) => event.event_id), ["event-1"]);
  });
});
