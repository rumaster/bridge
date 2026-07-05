import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
} from "../../../packages/contracts/src/c10.js";

/**
 * Маршрутизация SVC-NOTIF (ТЗ §15.2, §15.4, §15.5).
 *
 * Реализует M3/M4 «маппинг событие → категория/адресат → каналы»:
 *  - `PRODUCER_DEFAULT_CATEGORY` — категория по умолчанию для продюсера, если
 *    событие пришло без явной категории (событие → категория, ТЗ §15.5);
 *  - `NOTIFICATION_CATEGORY_CHANNELS` — набор каналов, пригодных для категории
 *    (категория → каналы, ТЗ §15.4). Более критичные категории получают больше
 *    каналов доставки (email/push подключаются на M4);
 *  - `resolveTargetChannels` — фактические каналы доставки: пересечение
 *    пригодных для категории каналов и включённых подписок пользователя
 *    (уважение настроек, ТЗ §15.6).
 */

// Категория по умолчанию для продюсера события (ТЗ §15.2): используется, если
// продюсер не проставил категорию явно. Категория из события всегда приоритетна.
export const PRODUCER_DEFAULT_CATEGORY = Object.freeze({
  "SVC-CORE": "info",
  "SVC-BCAST": "warning",
  "SVC-AI": "info",
  "SVC-FBP": "info",
  "SVC-API": "info",
  "SVC-IDN": "admin",
  "SVC-DATA": "warning",
});

// Пригодные каналы по категориям (ТЗ §15.4). web/telegram доступны всем
// категориям (M3); email/push подключаются для более критичных категорий (M4).
export const NOTIFICATION_CATEGORY_CHANNELS = Object.freeze({
  info: Object.freeze(["web", "telegram"]),
  warning: Object.freeze(["web", "telegram", "email"]),
  error: Object.freeze(["web", "telegram", "email", "push"]),
  critical: Object.freeze(["web", "telegram", "email", "push"]),
  admin: Object.freeze(["web", "telegram", "email"]),
});

export const PRIORITY_NOTIFICATION_CATEGORIES = Object.freeze(["critical", "admin"]);

// M5: приоритетные категории получают несколько попыток доставки, остальные
// деградируют быстро и не блокируют доступные каналы.
export const NOTIFICATION_DELIVERY_POLICIES = Object.freeze({
  info: Object.freeze({ max_attempts: 1 }),
  warning: Object.freeze({ max_attempts: 1 }),
  error: Object.freeze({ max_attempts: 2 }),
  critical: Object.freeze({ max_attempts: 3 }),
  admin: Object.freeze({ max_attempts: 3 }),
});

export function eligibleChannelsForCategory(category) {
  return [...(NOTIFICATION_CATEGORY_CHANNELS[category] ?? ["web"])];
}

export function isPriorityNotificationCategory(category) {
  return PRIORITY_NOTIFICATION_CATEGORIES.includes(category);
}

export function deliveryPolicyForCategory(category) {
  return {
    ...(NOTIFICATION_DELIVERY_POLICIES[category] ?? NOTIFICATION_DELIVERY_POLICIES.info),
  };
}

/**
 * Определить категорию и адресата уведомления по событию продюсера (ТЗ §15.5).
 * Категория берётся из события; при её отсутствии — из карты продюсера.
 */
export function routeProducerEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("producer event must be an object");
  }

  const category = NOTIFICATION_CATEGORIES.includes(event.category)
    ? event.category
    : PRODUCER_DEFAULT_CATEGORY[event.producer_service_id] ?? "info";

  return {
    category,
    recipient_user_id: event.recipient_user_id,
    organization_id: event.organization_id,
    producer_service_id: event.producer_service_id,
    eligible_channels: eligibleChannelsForCategory(category),
  };
}

/**
 * Фактические каналы доставки уведомления: каналы, пригодные для категории и
 * включённые в подписках пользователя (ТЗ §15.6). Отключённая подписка ⇒ канал
 * исключается из доставки.
 */
export function resolveTargetChannels({ category, settings = [] }) {
  const eligible = eligibleChannelsForCategory(category);
  const enabled = new Set(
    settings
      .filter((setting) => setting.category === category && setting.enabled === true)
      .map((setting) => setting.channel),
  );

  return eligible.filter((channel) => enabled.has(channel));
}

export function isSupportedChannel(channel) {
  return NOTIFICATION_CHANNELS.includes(channel);
}
