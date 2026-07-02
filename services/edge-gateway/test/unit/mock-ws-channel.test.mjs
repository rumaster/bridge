import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWebSocketEvent } from "../../../../packages/contracts/src/c7.mjs";
import { createMockWebSocketChannel } from "../../src/mock-ws-channel.mjs";

function makeEvent(index) {
  return createWebSocketEvent({
    eventId: `event-${index}`,
    organizationId: "org-1",
    event: "message.created",
    sequenceNumber: index,
    payload: {
      message_id: `message-${index}`,
    },
    occurredAt: "2026-07-02T16:20:00.000Z",
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

  it("deduplicates events by event_id", () => {
    const channel = createMockWebSocketChannel();
    const first = channel.publish(makeEvent(1));
    const duplicate = channel.publish(makeEvent(1));

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(channel.getEvents().map((event) => event.event_id), ["event-1"]);
  });
});
