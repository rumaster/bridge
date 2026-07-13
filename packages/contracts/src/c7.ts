import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.js";
import {
  C7_CONTRACT,
  C7_EVENT_TYPES,
  C7_RECONNECT_SEMANTICS,
  C7_VERSION,
  C7_WS_API_PATH,
  C7_WS_PATH,
  C7_WS_SUBSCRIPTION_FILTERS,
} from "./c7-constants.js";

// Канонический источник C7-констант — c7-constants.ts (браузеро-безопасный, без
// node:fs). Здесь ре-экспортируем их для обратной совместимости импортов из c7.ts
// (W6/WG-15) и добавляем серверную часть: JSON-схему и валидацию.
export {
  C7_CONTRACT,
  C7_VERSION,
  C7_WS_PATH,
  C7_WS_API_PATH,
  C7_EVENT_TYPES,
  C7_RECONNECT_SEMANTICS,
  C7_WS_SUBSCRIPTION_FILTERS,
} from "./c7-constants.js";
export type { C7EventType, C7WebSocketEnvelope } from "./c7-constants.js";

export const C7_WEBSOCKET_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/c7-websocket-event.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

// Set<string>: `has()` вызывается с произвольной строкой (валидация входа), а не
// только с литералами C7EventType — иначе tsc сузит параметр до union.
const C7_EVENT_TYPE_SET = new Set<string>(C7_EVENT_TYPES);

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
