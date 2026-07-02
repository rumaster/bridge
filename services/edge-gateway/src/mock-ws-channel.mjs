import {
  selectEventsAfterCursor,
  validateWebSocketEvent,
} from "../../../packages/contracts/src/c7.mjs";

export class WebSocketChannelMockValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "WebSocketChannelMockValidationError";
    this.errors = errors;
  }
}

export function createMockWebSocketChannel({ initialEvents = [] } = {}) {
  const clients = new Set();
  const events = [];
  const eventIds = new Set();
  const metrics = {
    connection_total: 0,
    event_published_total: 0,
    duplicate_event_total: 0,
    rejected_event_total: 0,
  };

  const channel = {
    connect({ lastEventId, send }) {
      if (typeof send !== "function") {
        throw new TypeError("send must be a function");
      }

      const client = {
        closed: false,
        lastEventId,
        sendEvent(event) {
          if (this.closed) {
            return;
          }
          send(event);
          this.lastEventId = event.event_id;
        },
      };

      clients.add(client);
      metrics.connection_total += 1;

      for (const event of selectEventsAfterCursor(events, lastEventId)) {
        client.sendEvent(event);
      }

      return {
        close() {
          if (!client.closed) {
            client.closed = true;
            clients.delete(client);
          }
        },
        get lastEventId() {
          return client.lastEventId;
        },
      };
    },

    publish(event) {
      const validation = validateWebSocketEvent(event);

      if (!validation.valid) {
        metrics.rejected_event_total += 1;
        throw new WebSocketChannelMockValidationError(
          `Invalid C7 WebSocket event: ${validation.errors.join("; ")}`,
          validation.errors,
        );
      }

      if (eventIds.has(event.event_id)) {
        metrics.duplicate_event_total += 1;
        const existingEvent = events.find((item) => item.event_id === event.event_id);
        return {
          accepted: true,
          duplicate: true,
          event: existingEvent,
        };
      }

      const storedEvent = Object.freeze({ ...event });
      events.push(storedEvent);
      eventIds.add(storedEvent.event_id);
      metrics.event_published_total += 1;

      for (const client of clients) {
        client.sendEvent(storedEvent);
      }

      return {
        accepted: true,
        duplicate: false,
        event: storedEvent,
      };
    },

    getEvents({ afterEventId } = {}) {
      return selectEventsAfterCursor(events, afterEventId);
    },

    getMetrics() {
      return {
        ...metrics,
        connected_clients: clients.size,
        retained_events: events.length,
      };
    },
  };

  for (const event of initialEvents) {
    channel.publish(event);
  }

  return channel;
}
