import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.js";

export const C7_CONTRACT = "C7.WebSocketEvent";
export const C7_VERSION = "1.0.0";
export const C7_WS_PATH = "/ws";
export const C7_WS_API_PATH = "/api/v1/ws";

export const C7_EVENT_TYPES = Object.freeze([
  "message.created",
  "message.status_changed",
  "typing.started",
  "typing.stopped",
  "client.status_changed",
  "channel.status_changed",
  "notification.created",
  "broadcast.state_changed",
  "workflow.state_changed",
]);

export const C7_RECONNECT_SEMANTICS = Object.freeze({
  mode: "client_auto_reconnect",
  resume_cursor: "last_event_id",
  fallback_cursor: "after_sequence_number",
  delivery: "at_least_once_with_client_dedup",
  duplicate_rule: "drop events with event_id already observed by the client",
  ordering: "sequence_number is monotonic inside one WebSocket subscription",
});

export const C7_WS_SUBSCRIPTION_FILTERS = Object.freeze([
  "organization_id",
  "subscription_id",
  "conversation_id",
  "endpoint_id",
  "client_id",
  "recipient_user_id",
  "user_id",
  "manager_user_id",
  "visitor_session_id",
]);

export const C7_WEBSOCKET_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/c7-websocket-event.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

const C7_EVENT_TYPE_SET = new Set(C7_EVENT_TYPES);

/** Входные данные {@link createWebSocketEvent} (C7.WebSocketEvent). */
export interface CreateWebSocketEventInput {
  eventId: string;
  organizationId: string;
  event: string;
  sequenceNumber: number;
  payload: unknown;
  occurredAt?: string;
  subscriptionId?: string;
}

export function createWebSocketEvent({
  eventId,
  organizationId,
  event,
  sequenceNumber,
  payload,
  occurredAt = new Date().toISOString(),
  subscriptionId,
}: CreateWebSocketEventInput) {
  if (!C7_EVENT_TYPE_SET.has(event)) {
    throw new TypeError(`Unsupported C7 WebSocket event: ${event}`);
  }

  return {
    contract: C7_CONTRACT,
    version: C7_VERSION,
    event,
    event_id: eventId,
    organization_id: organizationId,
    ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    sequence_number: sequenceNumber,
    payload,
    occurred_at: occurredAt,
  };
}

export function validateWebSocketEvent(event) {
  const validation = validateJsonSchema(event, C7_WEBSOCKET_EVENT_SCHEMA);
  const errors = [...validation.errors];

  if (
    isRecord(event) &&
    typeof event.event === "string" &&
    !C7_EVENT_TYPE_SET.has(event.event)
  ) {
    errors.push(`event ${event.event} is not part of C7 v1`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function selectEventsAfterCursor(events, lastEventId) {
  if (!lastEventId) {
    return [...events];
  }

  const cursorIndex = events.findIndex((event) => event.event_id === lastEventId);

  if (cursorIndex === -1) {
    return [...events];
  }

  return events.slice(cursorIndex + 1);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
