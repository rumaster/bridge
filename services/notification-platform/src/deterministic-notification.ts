import { createHash } from "node:crypto";

import {
  C10_VERSION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  createNotification,
} from "../../../packages/contracts/src/c10.js";
import { createDefaultChannelAdapters } from "./channel-adapters.js";
import {
  C10DtoValidationError,
  assertListNotificationsQuery,
  assertNotificationTriggerEventPayload,
  assertUpdateNotificationSettingsRequest,
} from "./c10-dto.js";
import {
  deliveryPolicyForCategory,
  resolveTargetChannels,
  routeProducerEvent,
} from "./notification-routing.js";

export class C10NotificationNotFoundError extends Error {
  readonly notificationId: string;

  constructor(notificationId: string) {
    super(`Notification ${notificationId} was not found for the current user.`);
    this.name = "C10NotificationNotFoundError";
    this.notificationId = notificationId;
  }
}

export function createDeterministicNotificationMock({
  now = () => new Date().toISOString(),
  channels = createDefaultChannelAdapters({ now }),
} = {}) {
  const notifications = new Map();
  // Индекс адресата для NFR ≤ 1 с (ТЗ §25.2): `${org}:${user}` -> id[] (новые первыми).
  const recipientIndex = new Map();
  // Ключ логического события -> id уведомления (дедупликация, ТЗ §15, инвариант §4).
  const dedupeIndex = new Map();
  // id уведомления -> список записей доставки по каналам.
  const deliveriesByNotification = new Map();
  const settingsByUser = new Map();
  const metrics = {
    list_total: 0,
    mark_read_total: 0,
    settings_read_total: 0,
    settings_update_total: 0,
    producer_event_total: 0,
    duplicate_total: 0,
    delivery_total: 0,
    delivery_web_total: 0,
    delivery_telegram_total: 0,
    delivery_email_total: 0,
    delivery_push_total: 0,
    delivery_failed_total: 0,
    delivery_web_failed_total: 0,
    delivery_telegram_failed_total: 0,
    delivery_email_failed_total: 0,
    delivery_push_failed_total: 0,
    delivery_retry_total: 0,
    delivery_skipped_total: 0,
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
  indexNotification(seedNotification);

  function indexNotification(notification) {
    notifications.set(notification.id, notification);
    const key = recipientKey(notification.organization_id, notification.recipient_user_id);
    const ids = recipientIndex.get(key);
    if (ids) {
      ids.unshift(notification.id);
    } else {
      recipientIndex.set(key, [notification.id]);
    }
    if (notification.dedupe_key) {
      dedupeIndex.set(
        dedupeKeyOf(notification.organization_id, notification.recipient_user_id, notification.dedupe_key),
        notification.id,
      );
    }
  }

  function recipientNotifications(context) {
    const ids = recipientIndex.get(recipientKey(context.organizationId, context.userId)) ?? [];
    return ids
      .map((id) => notifications.get(id))
      .filter((notification) => notification !== undefined);
  }

  function deliver(notification, targetChannels) {
    const deliveries = [];
    const failedDeliveries = [];
    let webEvent = null;
    const policy = deliveryPolicyForCategory(notification.category);

    for (const channel of targetChannels) {
      const adapter = channels[channel];
      const { record, retryCount } = deliverToChannel({
        adapter,
        channel,
        notification,
        policy,
        now,
      });
      deliveries.push(record);

      metrics.delivery_retry_total += retryCount;

      if (record.status === "sent") {
        metrics.delivery_total += 1;
        metrics[`delivery_${channel}_total`] += 1;
      } else {
        failedDeliveries.push(record);
        metrics.delivery_failed_total += 1;
        metrics[`delivery_${channel}_failed_total`] += 1;
      }

      if (channel === "web" && record.status === "sent" && record.event) {
        webEvent = record.event;
      }
    }

    deliveriesByNotification.set(notification.id, deliveries);
    return { deliveries, failedDeliveries, webEvent };
  }

  return {
    listNotifications(context, query = {}) {
      const filters = assertListNotificationsQuery(query);
      const filtered = recipientNotifications(context)
        .filter((notification) => !filters.status || notification.status === filters.status)
        .filter((notification) => !filters.category || notification.category === filters.category);

      const start = filters.cursor ? cursorStartIndex(filtered, filters.cursor) : 0;
      const items = filtered.slice(start, start + filters.limit);
      const nextIndex = start + filters.limit;
      const nextCursor =
        nextIndex < filtered.length ? encodeCursor(filtered[nextIndex - 1]) : null;

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
          next_cursor: nextCursor,
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

      settingsByUser.set(
        userKey(context),
        mergeSettings(getSettingsForUser(settingsByUser, context), request.settings),
      );
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
      const route = routeProducerEvent(event);
      const dedupeLookup = dedupeKeyOf(
        event.organization_id,
        event.recipient_user_id,
        event.dedupe_key,
      );

      // Дедупликация: один ключ логического события не порождает дубль
      // уведомления и повторную доставку (ТЗ §15, инвариант §4.3).
      const existingId = dedupeIndex.get(dedupeLookup);
      if (existingId) {
        metrics.producer_event_total += 1;
        metrics.duplicate_total += 1;
        const existing = notifications.get(existingId);
        const deliveries = deliveriesByNotification.get(existingId) ?? [];

        return acceptResponse({
          event,
          notification: existing,
          duplicate: true,
          deliveries,
          webEvent:
            deliveries.find(
              (record) => record.channel === "web" && record.status === "sent",
            )?.event ?? null,
        });
      }

      const settings = getSettingsForUser(settingsByUser, {
        organizationId: event.organization_id,
        userId: event.recipient_user_id,
      });
      const targetChannels = resolveTargetChannels({ category: route.category, settings });

      const notification = createNotification({
        notificationId: createDeterministicUuid([
          event.organization_id,
          event.recipient_user_id,
          event.dedupe_key,
        ]),
        organizationId: event.organization_id,
        recipientUserId: event.recipient_user_id,
        category: route.category,
        title: event.title,
        body: event.body,
        payload: {
          ...event.payload,
          producer_service_id: event.producer_service_id,
          producer_event_id: event.producer_event_id,
        },
        channels: targetChannels.length > 0 ? targetChannels : ["web"],
        createdAt: now(),
        dedupeKey: event.dedupe_key,
      });
      indexNotification(notification);
      metrics.producer_event_total += 1;

      const skipped = route.eligible_channels.filter(
        (channel) => !targetChannels.includes(channel),
      );
      metrics.delivery_skipped_total += skipped.length;

      const { deliveries, failedDeliveries, webEvent } = deliver(
        notification,
        targetChannels,
      );

      return acceptResponse({
        event,
        notification,
        duplicate: false,
        deliveries,
        failedDeliveries,
        webEvent,
        skippedChannels: skipped,
      });
    },

    getDeliveries(notificationId) {
      return (deliveriesByNotification.get(notificationId) ?? []).map((record) => ({
        ...record,
      }));
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

interface AcceptResponseInput {
  event: any;
  notification: any;
  duplicate: boolean;
  deliveries: any;
  failedDeliveries?: any;
  webEvent?: any;
  skippedChannels?: any[];
}

function acceptResponse({
  event,
  notification,
  duplicate,
  deliveries,
  failedDeliveries,
  webEvent,
  skippedChannels = [],
}: AcceptResponseInput) {
  const failureRecords =
    failedDeliveries ?? deliveries.filter((record) => record.status === "failed");
  const publicFailedDeliveries = failureRecords.map((record) => publicDelivery(record));

  return {
    contract: "C10.AcceptNotificationTriggerResponse",
    version: C10_VERSION,
    request_id: event.event_id,
    organization_id: event.organization_id,
    accepted: true,
    duplicate,
    degraded: publicFailedDeliveries.length > 0,
    notification,
    deliveries: deliveries.map((record) => publicDelivery(record)),
    failed_deliveries: publicFailedDeliveries,
    skipped_channels: skippedChannels,
    notification_created_event: webEvent,
  };
}

function publicDelivery(record) {
  const { event, ...rest } = record;
  return { ...rest };
}

function deliverToChannel({ adapter, channel, notification, policy, now }) {
  const maxAttempts = Math.max(1, policy.max_attempts ?? 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!adapter || typeof adapter.deliver !== "function") {
        throw new Error(`Channel adapter ${channel} is not configured.`);
      }

      return {
        record: {
          ...adapter.deliver({ notification, attempt }),
          attempts: attempt,
          max_attempts: maxAttempts,
        },
        retryCount: attempt - 1,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    record: failedDeliveryRecord({
      channel,
      notification,
      attempts: maxAttempts,
      maxAttempts,
      error: lastError,
      now,
    }),
    retryCount: maxAttempts - 1,
  };
}

function failedDeliveryRecord({
  channel,
  notification,
  attempts,
  maxAttempts,
  error,
  now,
}) {
  return {
    channel,
    status: "failed",
    provider: `${channel}-adapter`,
    provider_ref: `${channel}:${notification.id}:failed`,
    dispatched_at: now(),
    attempts,
    max_attempts: maxAttempts,
    error: errorMessage(error),
  };
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown delivery error");
}

function getSettingsForUser(settingsByUser, context) {
  const existing = settingsByUser.get(userKey(context));
  return normalizeSettings(existing ?? []);
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

function mergeSettings(baseSettings, overrides) {
  return normalizeSettings([...baseSettings, ...overrides]);
}

function normalizeSettings(settings) {
  const defaults = createDefaultSettings();
  const byPair = new Map(
    defaults.map((setting) => [settingKey(setting), { ...setting }]),
  );

  for (const setting of settings) {
    byPair.set(settingKey(setting), { ...setting });
  }

  return defaults.map((setting) => ({ ...byPair.get(settingKey(setting)) }));
}

function settingKey(setting) {
  return `${setting.category}:${setting.channel}`;
}

function userKey(context) {
  return `${context.organizationId}:${context.userId}`;
}

function recipientKey(organizationId, userId) {
  return `${organizationId}:${userId}`;
}

function dedupeKeyOf(organizationId, userId, dedupeKey) {
  return `${organizationId}${userId}${dedupeKey}`;
}

function encodeCursor(notification) {
  return Buffer.from(`${notification.created_at}${notification.id}`, "utf8").toString(
    "base64url",
  );
}

function cursorStartIndex(items, cursor) {
  let decoded;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return 0;
  }
  const [, id] = decoded.split("");
  const position = items.findIndex((notification) => notification.id === id);
  return position === -1 ? items.length : position + 1;
}

function createDeterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.join("")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
