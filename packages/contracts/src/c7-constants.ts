/**
 * Браузеро-безопасные константы и типы контракта C7 (WebSocket events).
 *
 * Выделено из [`c7.ts`](./c7.ts), который тянет `node:fs` (JSON-схема) и потому не
 * импортируется во фронтенд. Здесь — только литералы и типы, без побочных
 * эффектов, чтобы канонический источник C7-констант был один и для Node, и для
 * браузера (устраняет дубль типов в виджете Web Chat, W6/WG-15,
 * docs/plan/web-chat-channel-production.md).
 */
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
] as const);

export type C7EventType = (typeof C7_EVENT_TYPES)[number];

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

/** Канонический конверт события C7 (C7.WebSocketEvent). */
export interface C7WebSocketEnvelope<TPayload = Record<string, unknown>> {
  contract: typeof C7_CONTRACT;
  version: typeof C7_VERSION;
  event: C7EventType;
  event_id: string;
  organization_id: string;
  subscription_id?: string;
  sequence_number: number;
  payload: TPayload;
  occurred_at: string;
}
