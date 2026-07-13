import {
  validateWebSocketEvent,
} from "../../../packages/contracts/src/c7.js";

interface C7Event {
  event_id: string;
  sequence_number?: number;
  payload?: unknown;
  [key: string]: unknown;
}

type C7EventSubscriber = (event: C7Event) => void;

export interface NormalizedSubscription {
  organizationId?: string;
  subscriptionId?: string;
  conversationId?: string;
  endpointId?: string;
  clientId?: string;
  recipientUserId?: string;
  userId?: string;
  managerUserId?: string;
  visitorSessionId?: string;
}

export interface CreateInMemoryC7EventStoreOptions {
  initialEvents?: C7Event[];
}

export interface C7EventSelectOptions {
  afterSequenceNumber?: number | string;
  lastEventId?: string;
  subscription?: NormalizedSubscription;
}

interface MockWebSocketClient {
  closed: boolean;
  lastEventId?: string;
  subscription: NormalizedSubscription;
  /** Подписка ограничена по organization_id (иначе событий не получает, W3). */
  scoped: boolean;
  sendEvent(event: C7Event): void;
}

export interface C7ChannelConnectOptions {
  afterSequenceNumber?: number | string;
  lastEventId?: string;
  send?: C7EventSubscriber;
  subscription?: unknown;
}

export interface C7ChannelGetEventsOptions {
  afterEventId?: string;
  afterSequenceNumber?: number | string;
  subscription?: unknown;
}

export interface CreateMockWebSocketChannelOptions {
  eventBus?: any;
  eventStore?: any;
  initialEvents?: C7Event[];
}

export class WebSocketChannelMockValidationError extends Error {
  readonly errors: string[];

  constructor(message: string, errors: string[]) {
    super(message);
    this.name = "WebSocketChannelMockValidationError";
    this.errors = errors;
  }
}

export function createInMemoryC7EventStore({
  initialEvents = [],
}: CreateInMemoryC7EventStoreOptions = {}) {
  const events = [];
  const eventIds = new Set();

  const store = {
    append(event) {
      if (eventIds.has(event.event_id)) {
        return {
          duplicate: true,
          event: events.find((item) => item.event_id === event.event_id),
        };
      }

      const storedEvent = Object.freeze(structuredClone(event));
      events.push(storedEvent);
      eventIds.add(storedEvent.event_id);

      return {
        duplicate: false,
        event: storedEvent,
      };
    },

    select({ afterSequenceNumber, lastEventId, subscription }: C7EventSelectOptions = {}) {
      const scopedEvents = events.filter((event) =>
        eventMatchesSubscription(event, subscription),
      );
      const normalizedAfterSequenceNumber = normalizePositiveInteger(afterSequenceNumber);

      if (lastEventId) {
        const cursorIndex = scopedEvents.findIndex((event) => event.event_id === lastEventId);

        if (cursorIndex !== -1) {
          return scopedEvents.slice(cursorIndex + 1);
        }
      }

      if (normalizedAfterSequenceNumber > 0) {
        return scopedEvents.filter(
          (event) => event.sequence_number > normalizedAfterSequenceNumber,
        );
      }

      return [...scopedEvents];
    },
  };

  for (const event of initialEvents) {
    store.append(event);
  }

  return store;
}

export function createInMemoryC7EventBus() {
  const subscribers = new Set<C7EventSubscriber>();

  return {
    publish(event) {
      for (const subscriber of subscribers) {
        subscriber(event);
      }
    },

    subscribe(subscriber) {
      if (typeof subscriber !== "function") {
        throw new TypeError("subscriber must be a function");
      }

      subscribers.add(subscriber);

      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

export function createMockWebSocketChannel({
  eventBus = createInMemoryC7EventBus(),
  eventStore = createInMemoryC7EventStore(),
  initialEvents = [],
}: CreateMockWebSocketChannelOptions = {}) {
  const clients = new Set<MockWebSocketClient>();
  const metrics = {
    connection_total: 0,
    event_published_total: 0,
    duplicate_event_total: 0,
    rejected_event_total: 0,
    unscoped_rejected_total: 0,
  };
  const unsubscribeFromEventBus = eventBus.subscribe((event) => {
    for (const client of clients) {
      // Изоляция арендаторов (W3, WG-9): неограниченная по organization_id подписка
      // не получает событий (иначе wildcard = утечка в чужой поток).
      if (client.scoped && eventMatchesSubscription(event, client.subscription)) {
        client.sendEvent(event);
      }
    }
  });

  const channel = {
    connect({ afterSequenceNumber, lastEventId, send, subscription }: C7ChannelConnectOptions = {}) {
      if (typeof send !== "function") {
        throw new TypeError("send must be a function");
      }

      const normalizedSubscription = normalizeSubscription(subscription);
      const scoped = Boolean(normalizedSubscription.organizationId);
      const client = {
        closed: false,
        lastEventId,
        subscription: normalizedSubscription,
        scoped,
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

      if (!scoped) {
        // Изоляция арендаторов (W3, WG-9): подписка без organization_id не матчит
        // ничего — ни реплей истории, ни живой поток. Раньше это был wildcard.
        metrics.unscoped_rejected_total += 1;
      } else {
        for (const event of eventStore.select({
          afterSequenceNumber,
          lastEventId,
          subscription: client.subscription,
        })) {
          client.sendEvent(event);
        }
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

      const result = eventStore.append(event);

      if (result.duplicate) {
        metrics.duplicate_event_total += 1;
        return {
          accepted: true,
          duplicate: true,
          event: result.event,
        };
      }

      metrics.event_published_total += 1;
      eventBus.publish(result.event);

      return {
        accepted: true,
        duplicate: false,
        event: result.event,
      };
    },

    getEvents({ afterEventId, afterSequenceNumber, subscription }: C7ChannelGetEventsOptions = {}) {
      return eventStore.select({
        afterSequenceNumber,
        lastEventId: afterEventId,
        subscription: normalizeSubscription(subscription),
      });
    },

    getMetrics() {
      return {
        ...metrics,
        connected_clients: clients.size,
        retained_events: eventStore.select().length,
      };
    },

    close() {
      for (const client of clients) {
        client.closed = true;
      }
      clients.clear();
      unsubscribeFromEventBus();
    },
  };

  for (const event of initialEvents) {
    channel.publish(event);
  }

  return channel;
}

function normalizeSubscription(subscription): NormalizedSubscription {
  if (subscription === null || typeof subscription !== "object" || Array.isArray(subscription)) {
    return {};
  }

  return Object.freeze({
    organizationId: getString(subscription.organizationId ?? subscription.organization_id),
    subscriptionId: getString(subscription.subscriptionId ?? subscription.subscription_id),
    conversationId: getString(subscription.conversationId ?? subscription.conversation_id),
    endpointId: getString(subscription.endpointId ?? subscription.endpoint_id),
    clientId: getString(subscription.clientId ?? subscription.client_id),
    recipientUserId: getString(subscription.recipientUserId ?? subscription.recipient_user_id),
    userId: getString(subscription.userId ?? subscription.user_id),
    managerUserId: getString(subscription.managerUserId ?? subscription.manager_user_id),
    visitorSessionId: getString(subscription.visitorSessionId ?? subscription.visitor_session_id),
  });
}

function eventMatchesSubscription(event, subscription) {
  const normalized = normalizeSubscription(subscription);

  if (!hasSubscriptionFilters(normalized)) {
    return true;
  }

  return (
    matchesEventValue(event, normalized.organizationId, ["organization_id"], {
      includePayload: false,
    }) &&
    matchesEventValue(event, normalized.subscriptionId, [
      "subscription_id",
      "subscriptionId",
    ]) &&
    matchesEventValue(event, normalized.conversationId, [
      "conversation_id",
      "conversationId",
    ]) &&
    matchesEventValue(event, normalized.endpointId, ["endpoint_id", "endpointId"]) &&
    matchesEventValue(event, normalized.clientId, ["client_id", "clientId"]) &&
    matchesEventValue(event, normalized.recipientUserId, [
      "recipient_user_id",
      "recipientUserId",
    ]) &&
    matchesEventValue(event, normalized.userId, ["user_id", "userId"]) &&
    matchesEventValue(event, normalized.managerUserId, [
      "manager_user_id",
      "managerUserId",
    ]) &&
    matchesEventValue(event, normalized.visitorSessionId, [
      "visitor_session_id",
      "visitorSessionId",
    ], {
      strict: false,
    })
  );
}

function hasSubscriptionFilters(subscription) {
  return Object.values(subscription).some((value) => value !== undefined);
}

function matchesEventValue(
  event,
  expectedValue,
  keys,
  { includePayload = true, strict = true } = {},
) {
  if (expectedValue === undefined) {
    return true;
  }

  const values = collectEventValues(event, keys, { includePayload });

  if (values.length === 0) {
    return !strict;
  }

  return values.includes(expectedValue);
}

function collectEventValues(event, keys, { includePayload }) {
  const records = [event];
  const payload = event?.payload;

  if (includePayload && isRecord(payload)) {
    records.push(payload);

    for (const nestedKey of ["message", "notification", "broadcast", "workflow"]) {
      if (isRecord(payload[nestedKey])) {
        records.push(payload[nestedKey]);
      }
    }
  }

  const values = [];

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }

    for (const key of keys) {
      const value = getString(record[key]);

      if (value !== undefined) {
        values.push(value);
      }
    }
  }

  return values;
}

function normalizePositiveInteger(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return Number(value);
  }

  return 0;
}

function getString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
