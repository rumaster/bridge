import { randomUUID } from "node:crypto";

import { createWebSocketEvent } from "../../../packages/contracts/src/c7.js";

export function createC7RealtimePublisher({
  clock = () => new Date().toISOString(),
  eventIdFactory = randomUUID,
  wsChannel,
} = {}) {
  if (!wsChannel || typeof wsChannel.publish !== "function") {
    throw new TypeError("wsChannel with publish(event) is required");
  }

  const sequenceNumbers = new Map();

  return {
    async publish(event) {
      const envelope = normalizeC7PublishEvent({
        clock,
        event,
        eventIdFactory,
        resolveSequenceNumber(organizationId, explicitSequenceNumber) {
          if (
            Number.isSafeInteger(explicitSequenceNumber) &&
            explicitSequenceNumber > 0
          ) {
            sequenceNumbers.set(
              organizationId,
              Math.max(sequenceNumbers.get(organizationId) ?? 0, explicitSequenceNumber),
            );
            return explicitSequenceNumber;
          }

          const next = (sequenceNumbers.get(organizationId) ?? 0) + 1;
          sequenceNumbers.set(organizationId, next);
          return next;
        },
      });
      const result = wsChannel.publish(envelope);

      return result.event;
    },
  };
}

function normalizeC7PublishEvent({
  clock,
  event,
  eventIdFactory,
  resolveSequenceNumber,
}) {
  if (event?.contract === "C7.WebSocketEvent") {
    return event;
  }

  const organizationId = event?.organizationId ?? event?.organization_id;

  if (typeof organizationId !== "string" || organizationId.length === 0) {
    throw new TypeError("organizationId is required for C7 realtime publishing");
  }

  return createWebSocketEvent({
    event: event.event,
    eventId: event.eventId ?? event.event_id ?? eventIdFactory(),
    organizationId,
    payload: event.payload ?? {},
    sequenceNumber: resolveSequenceNumber(
      organizationId,
      event.sequenceNumber ?? event.sequence_number,
    ),
    occurredAt: event.occurredAt ?? event.occurred_at ?? clock(),
    subscriptionId: event.subscriptionId ?? event.subscription_id,
  });
}
