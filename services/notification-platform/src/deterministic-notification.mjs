import { createHash } from "node:crypto";

import {
  C10_VERSION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  createNotification,
  createNotificationCreatedEvent,
} from "../../../packages/contracts/src/c10.mjs";
import {
  C10DtoValidationError,
  assertListNotificationsQuery,
  assertNotificationTriggerEventPayload,
  assertUpdateNotificationSettingsRequest,
} from "./c10-dto.mjs";

export class C10NotificationNotFoundError extends Error {
  constructor(notificationId) {
    super(`Notification ${notificationId} was not found for the current user.`);
    this.name = "C10NotificationNotFoundError";
    this.notificationId = notificationId;
  }
}

export function createDeterministicNotificationMock({
  now = () => new Date().toISOString(),
} = {}) {
  const notifications = new Map();
  const settingsByUser = new Map();
  const metrics = {
    list_total: 0,
    mark_read_total: 0,
    settings_read_total: 0,
    settings_update_total: 0,
    producer_event_total: 0,
  };

  const seedNotification = createNotification({
    notificationId: "notification-m0-1",
    organizationId: "org-1",
    recipientUserId: "manager-1",
    category: "info",
    title: "M0 notification mock is ready",
    body: "C10 notifications are served by deterministic M0 data.",
    payload: {
      source: "notification-platform-m0",
    },
    channels: ["web", "telegram"],
    createdAt: "2026-07-02T16:30:00.000Z",
    dedupeKey: "m0:seed:manager-1",
  });
  notifications.set(seedNotification.id, seedNotification);

  return {
    listNotifications(context, query = {}) {
      const filters = assertListNotificationsQuery(query);
      const items = [...notifications.values()]
        .filter((notification) => notification.organization_id === context.organizationId)
        .filter((notification) => notification.recipient_user_id === context.userId)
        .filter((notification) => !filters.status || notification.status === filters.status)
        .filter((notification) => !filters.category || notification.category === filters.category)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, filters.limit);

      metrics.list_total += 1;

      return {
        contract: "C10.ListNotificationsResponse",
        version: C10_VERSION,
        request_id: context.requestId,
        organization_id: context.organizationId,
        recipient_user_id: context.userId,
        items,
        page: {
          limit: filters.limit,
          next_cursor: null,
        },
      };
    },

    markNotificationRead(notificationId, context) {
      const notification = notifications.get(notificationId);
      if (
        !notification ||
        notification.organization_id !== context.organizationId ||
        notification.recipient_user_id !== context.userId
      ) {
        throw new C10NotificationNotFoundError(notificationId);
      }

      const updated = {
        ...notification,
        status: "read",
        read_at: now(),
      };
      notifications.set(notificationId, updated);
      metrics.mark_read_total += 1;

      return {
        contract: "C10.MarkNotificationReadResponse",
        version: C10_VERSION,
        request_id: context.requestId,
        organization_id: context.organizationId,
        notification: updated,
      };
    },

    getNotificationSettings(context) {
      metrics.settings_read_total += 1;

      return {
        contract: "C10.NotificationSettingsResponse",
        version: C10_VERSION,
        request_id: context.requestId,
        organization_id: context.organizationId,
        user_id: context.userId,
        settings: getSettingsForUser(settingsByUser, context),
      };
    },

    updateNotificationSettings(context, payload) {
      const request = assertUpdateNotificationSettingsRequest(payload);

      if (
        request.organization_id !== context.organizationId ||
        request.user_id !== context.userId
      ) {
        throw new C10DtoValidationError([
          {
            field: "organization_id",
            message: "organization_id must match the request context.",
          },
          {
            field: "user_id",
            message: "user_id must match the request context.",
          },
        ]);
      }

      settingsByUser.set(userKey(context), request.settings.map((setting) => ({ ...setting })));
      metrics.settings_update_total += 1;

      return {
        contract: "C10.NotificationSettingsResponse",
        version: C10_VERSION,
        request_id: request.request_id,
        organization_id: context.organizationId,
        user_id: context.userId,
        settings: getSettingsForUser(settingsByUser, context),
      };
    },

    acceptProducerEvent(payload) {
      const event = assertNotificationTriggerEventPayload(payload);
      const existing = [...notifications.values()].find(
        (notification) =>
          notification.organization_id === event.organization_id &&
          notification.recipient_user_id === event.recipient_user_id &&
          notification.dedupe_key === event.dedupe_key,
      );

      const notification =
        existing ??
        createNotification({
          notificationId: createDeterministicUuid([
            event.organization_id,
            event.recipient_user_id,
            event.dedupe_key,
          ]),
          organizationId: event.organization_id,
          recipientUserId: event.recipient_user_id,
          category: event.category,
          title: event.title,
          body: event.body,
          payload: {
            ...event.payload,
            producer_service_id: event.producer_service_id,
            producer_event_id: event.producer_event_id,
          },
          channels: enabledChannelsFor(settingsByUser, {
            organizationId: event.organization_id,
            userId: event.recipient_user_id,
            category: event.category,
          }),
          createdAt: now(),
          dedupeKey: event.dedupe_key,
        });

      notifications.set(notification.id, notification);
      metrics.producer_event_total += 1;

      return {
        contract: "C10.AcceptNotificationTriggerResponse",
        version: C10_VERSION,
        request_id: event.event_id,
        organization_id: event.organization_id,
        accepted: true,
        duplicate: Boolean(existing),
        notification,
        notification_created_event: createNotificationCreatedEvent({
          eventId: `${notification.id}:created`,
          notification,
          occurredAt: notification.created_at,
        }),
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function getSettingsForUser(settingsByUser, context) {
  const existing = settingsByUser.get(userKey(context));
  if (existing) {
    return existing.map((setting) => ({ ...setting }));
  }

  return createDefaultSettings();
}

function enabledChannelsFor(settingsByUser, { organizationId, userId, category }) {
  const settings = getSettingsForUser(settingsByUser, { organizationId, userId });
  const enabled = settings
    .filter((setting) => setting.category === category && setting.enabled)
    .map((setting) => setting.channel);

  return enabled.length > 0 ? enabled : ["web"];
}

function createDefaultSettings() {
  return NOTIFICATION_CATEGORIES.flatMap((category) =>
    NOTIFICATION_CHANNELS.map((channel) => ({
      category,
      channel,
      enabled: channel === "web" || channel === "telegram",
    })),
  );
}

function userKey(context) {
  return `${context.organizationId}:${context.userId}`;
}

function createDeterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
