import { createNotificationCreatedEvent } from "../../../packages/contracts/src/c10.js";

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

export function createDefaultChannelAdapters({
  now = () => new Date().toISOString(),
  telegramForwardUrl = process.env.SVC_TGC_NOTIFICATIONS_URL?.trim() || null,
  fetchImpl = globalThis.fetch,
  logger = console,
}: {
  now?: () => string;
  telegramForwardUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
  logger?: any;
} = {}) {
  return {
    web: createWebChannelAdapter({ now }),
    // Telegram-плечо (G-8): при заданном SVC_TGC_NOTIFICATIONS_URL карточка реально
    // форвардится в SVC-TGC (Telegram Console менеджера); без URL — записывающий
    // mock для dev/CI (без внешних вызовов), как у остальных провайдеров.
    telegram: telegramForwardUrl
      ? createTelegramForwardingChannelAdapter({ url: telegramForwardUrl, now, fetchImpl, logger })
      : createTelegramChannelAdapter({ now }),
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

/** Опции {@link createTelegramForwardingChannelAdapter}. */
export interface TelegramForwardingChannelAdapterOptions {
  url: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
  logger?: any;
}

/**
 * Боевое Telegram-плечо SVC-NOTIF (G-8): вместо записи-мока форвардит карточку
 * уведомления в SVC-TGC (Telegram Console менеджера) по HTTP
 * `POST {url}/internal/notifications/telegram`. SVC-TGC владеет резолвом chat_id
 * менеджера (по привязанной сессии) и фактической отправкой карточки.
 *
 * Конвейер доставки SVC-NOTIF синхронный (`deliver` возвращает запись, а не
 * Promise), поэтому запись о передаче формируется сразу (handoff = «принято
 * telegram-плечом»), а реальный HTTP-вызов идёт фоном (best-effort): его сбой не
 * блокирует остальные каналы (web/email/push) и не роняет приём события.
 * Результаты форварда доступны через `getForwardResults()`, а `drain()` дожидается
 * незавершённых вызовов (детерминизм в тестах).
 */
export function createTelegramForwardingChannelAdapter({
  url,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  logger = console,
}: TelegramForwardingChannelAdapterOptions) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("createTelegramForwardingChannelAdapter requires a target url");
  }
  const apiBase = url.replace(/\/+$/, "");
  const dispatches = [];
  const forwardResults = [];
  const pending = new Set<Promise<unknown>>();

  return {
    channel: "telegram",
    deliver({ notification }) {
      const record = {
        channel: "telegram",
        status: "sent",
        provider: "svc-tgc",
        provider_ref: `telegram:${notification.id}`,
        dispatched_at: now(),
        forwarded_to: apiBase,
      };
      dispatches.push({
        notification_id: notification.id,
        organization_id: notification.organization_id,
        recipient_user_id: notification.recipient_user_id,
        category: notification.category,
        ...record,
      });

      const task = forwardTelegramNotification({ apiBase, fetchImpl, notification })
        .then((result) => {
          forwardResults.push({ notification_id: notification.id, ok: true, ...result });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          forwardResults.push({ notification_id: notification.id, ok: false, error: message });
          logger?.warn?.("SVC-TGC telegram notification forward failed", {
            notification_id: notification.id,
            error: message,
          });
        })
        .finally(() => {
          pending.delete(task);
        });
      pending.add(task);

      return record;
    },
    getDispatches() {
      return dispatches.map((dispatch) => ({ ...dispatch }));
    },
    getForwardResults() {
      return forwardResults.map((result) => ({ ...result }));
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
  };
}

async function forwardTelegramNotification({ apiBase, fetchImpl, notification }) {
  const response = await fetchImpl(`${apiBase}/internal/notifications/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ notification }),
  });
  if (!response.ok) {
    throw new Error(`SVC-TGC returned HTTP ${response.status}`);
  }
  return { status: response.status };
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

/** Опции {@link createRecordingChannelAdapter} и адаптеров-обёрток. */
export interface RecordingChannelAdapterOptions {
  channel?: string;
  provider?: string;
  now?: () => string;
}

/**
 * Универсальный записывающий адаптер для внешних каналов (telegram/email/push):
 * фиксирует доставку и возвращает детерминированный `provider_ref`.
 */
export function createRecordingChannelAdapter({
  channel,
  provider,
  now = () => new Date().toISOString(),
}: RecordingChannelAdapterOptions = {}) {
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
