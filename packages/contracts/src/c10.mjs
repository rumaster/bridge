import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.mjs";

export const C10_VERSION = "1.0.0";

export const NOTIFICATION_CATEGORIES = Object.freeze([
  "info",
  "warning",
  "error",
  "critical",
  "admin",
]);

export const NOTIFICATION_CHANNELS = Object.freeze([
  "web",
  "telegram",
  "email",
  "push",
]);

export const NOTIFICATION_STATUSES = Object.freeze(["new", "read"]);

export const NOTIFICATION_PRODUCER_SERVICE_IDS = Object.freeze([
  "SVC-CORE",
  "SVC-BCAST",
  "SVC-AI",
  "SVC-FBP",
  "SVC-API",
  "SVC-IDN",
  "SVC-DATA",
]);

export const NOTIFICATION_CREATED_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/notification-created.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const NOTIFICATION_TRIGGER_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/notification-trigger.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function createNotification({
  notificationId,
  organizationId,
  recipientUserId,
  category,
  title,
  body = "",
  payload = {},
  status = "new",
  channels = ["web"],
  createdAt = new Date().toISOString(),
  readAt = null,
  dedupeKey,
}) {
  assertOneOf(category, NOTIFICATION_CATEGORIES, "category");
  assertOneOf(status, NOTIFICATION_STATUSES, "status");

  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError("channels must contain at least one delivery channel");
  }

  for (const channel of channels) {
    assertOneOf(channel, NOTIFICATION_CHANNELS, "channel");
  }

  return {
    contract: "C10.Notification",
    version: C10_VERSION,
    id: notificationId,
    organization_id: organizationId,
    recipient_user_id: recipientUserId,
    category,
    title,
    body,
    payload,
    status,
    channels,
    created_at: createdAt,
    read_at: readAt,
    ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
  };
}

export function createNotificationCreatedEvent({
  eventId,
  notification,
  occurredAt = notification.created_at,
}) {
  return {
    contract: "C7.NotificationCreatedEvent",
    version: C10_VERSION,
    event: "notification.created",
    event_id: eventId,
    organization_id: notification.organization_id,
    recipient_user_id: notification.recipient_user_id,
    notification,
    occurred_at: occurredAt,
  };
}

export function createNotificationTriggerEvent({
  eventId,
  producerServiceId,
  producerEventId,
  organizationId,
  recipientUserId,
  category,
  title,
  body = "",
  payload = {},
  dedupeKey,
  occurredAt = new Date().toISOString(),
}) {
  assertOneOf(producerServiceId, NOTIFICATION_PRODUCER_SERVICE_IDS, "producer_service_id");
  assertOneOf(category, NOTIFICATION_CATEGORIES, "category");

  return {
    contract: "C10.NotificationTriggerEvent",
    version: C10_VERSION,
    event: "notification.triggered",
    event_id: eventId,
    producer_service_id: producerServiceId,
    producer_event_id: producerEventId,
    organization_id: organizationId,
    recipient_user_id: recipientUserId,
    category,
    title,
    body,
    payload,
    dedupe_key: dedupeKey,
    occurred_at: occurredAt,
  };
}

export function validateNotificationCreatedEvent(event) {
  return validateJsonSchema(event, NOTIFICATION_CREATED_EVENT_SCHEMA);
}

export function validateNotificationTriggerEvent(event) {
  return validateJsonSchema(event, NOTIFICATION_TRIGGER_EVENT_SCHEMA);
}

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(
      `Unsupported ${field}: ${value}. Expected one of ${allowed.join(", ")}.`,
    );
  }
}
