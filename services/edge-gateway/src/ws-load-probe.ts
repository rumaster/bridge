import { performance } from "node:perf_hooks";

import { createWebSocketEvent } from "../../../packages/contracts/src/c7.js";
import { createMockWebSocketChannel } from "./mock-ws-channel.js";

export function runMockWebSocketLoadProbe({
  channel = createMockWebSocketChannel(),
  connections = 100,
  events = 100,
  organizationId = "org-edge-load",
  conversationId = "conversation-edge-load",
  endpointId = "endpoint-edge-load",
  now = () => new Date().toISOString(),
} = {}) {
  assertNonNegativeInteger(connections, "connections");
  assertNonNegativeInteger(events, "events");

  const deliveredByConnection = Array.from({ length: connections }, () => 0);
  const connectionsToClose = [];
  let deliveredTotal = 0;

  const startedAt = performance.now();

  for (let index = 0; index < connections; index += 1) {
    const connectionIndex = index;
    connectionsToClose.push(
      channel.connect({
        subscription: {
          organizationId,
          conversationId,
        },
        send() {
          deliveredByConnection[connectionIndex] += 1;
          deliveredTotal += 1;
        },
      }),
    );
  }

  for (let sequenceNumber = 1; sequenceNumber <= events; sequenceNumber += 1) {
    channel.publish(
      createWebSocketEvent({
        eventId: `edge-load-event-${sequenceNumber}`,
        organizationId,
        event: "message.created",
        sequenceNumber,
        occurredAt: now(),
        payload: {
          message_id: `edge-load-message-${sequenceNumber}`,
          conversation_id: conversationId,
          endpoint_id: endpointId,
        },
      }),
    );
  }

  const completedAt = performance.now();
  for (const connection of connectionsToClose) {
    connection.close();
  }

  const durationMs = Math.max(0, completedAt - startedAt);
  const durationSeconds = durationMs > 0 ? durationMs / 1000 : 1;
  const metrics = channel.getMetrics();

  return {
    connections,
    events,
    delivered_total: deliveredTotal,
    delivered_by_connection: deliveredByConnection,
    retained_events: metrics.retained_events,
    duplicate_event_total: metrics.duplicate_event_total,
    rejected_event_total: metrics.rejected_event_total,
    duration_ms: durationMs,
    events_per_second: events / durationSeconds,
    deliveries_per_second: deliveredTotal / durationSeconds,
    metrics,
  };
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}
