import { createNotificationCreatedEvent } from "../../../packages/contracts/src/c10.mjs";

/**
 * Адаптеры каналов доставки уведомлений (ТЗ §15.4, §11.7, §20.3).
 *
 * SVC-NOTIF не отправляет во внешние каналы напрямую (границы §1): web — это
 * публикация WS-события `notification.created` (C7) для SVC-EDGE/SVC-MWS,
 * telegram — через SVC-INT/SVC-TGC, email/push — через внешних провайдеров.
 * Здесь эти внешние получатели смоделированы инъектируемыми моками, каждый
 * фиксирует факт доставки (для проверок и метрик, ТЗ §26.3).
 *
 * Каждый адаптер реализует единый интерфейс:
 *   { channel, deliver({ notification }) -> deliveryRecord, getDispatches() }
 * где deliveryRecord = { channel, status:"sent", provider, provider_ref,
 * dispatched_at, event? }.
 */

export function createDefaultChannelAdapters({ now = () => new Date().toISOString() } = {}) {
  return {
    web: createWebChannelAdapter({ now }),
    telegram: createTelegramChannelAdapter({ now }),
    email: createEmailChannelAdapter({ now }),
    push: createPushChannelAdapter({ now }),
  };
}

/**
 * Web-канал (C7): публикует WS-событие `notification.created`. Транспорт WS —
 * вне SVC-NOTIF (SVC-EDGE/SVC-API), здесь событие складывается в журнал-приёмник.
 */
export function createWebChannelAdapter({ now = () => new Date().toISOString() } = {}) {
  const events = [];

  return {
    channel: "web",
    deliver({ notification }) {
      const event = createNotificationCreatedEvent({
        eventId: `${notification.id}:created`,
        notification,
        occurredAt: notification.created_at,
      });
      events.push(event);

      return {
        channel: "web",
        status: "sent",
        provider: "svc-edge-ws",
        provider_ref: `ws:${notification.id}`,
        dispatched_at: now(),
        event,
      };
    },
    getDispatches() {
      return events.map((event) => ({ ...event }));
    },
  };
}

export function createTelegramChannelAdapter(options = {}) {
  return createRecordingChannelAdapter({
    channel: "telegram",
    provider: "svc-tgc",
    ...options,
  });
}

export function createEmailChannelAdapter(options = {}) {
  return createRecordingChannelAdapter({
    channel: "email",
    provider: "smtp-gateway",
    ...options,
  });
}

export function createPushChannelAdapter(options = {}) {
  return createRecordingChannelAdapter({
    channel: "push",
    provider: "push-gateway",
    ...options,
  });
}

/**
 * Универсальный записывающий адаптер для внешних каналов (telegram/email/push):
 * фиксирует доставку и возвращает детерминированный `provider_ref`.
 */
export function createRecordingChannelAdapter({
  channel,
  provider,
  now = () => new Date().toISOString(),
} = {}) {
  const dispatches = [];

  return {
    channel,
    deliver({ notification }) {
      const record = {
        channel,
        status: "sent",
        provider,
        provider_ref: `${channel}:${notification.id}`,
        dispatched_at: now(),
      };
      dispatches.push({
        notification_id: notification.id,
        organization_id: notification.organization_id,
        recipient_user_id: notification.recipient_user_id,
        category: notification.category,
        ...record,
      });

      return record;
    },
    getDispatches() {
      return dispatches.map((dispatch) => ({ ...dispatch }));
    },
  };
}
