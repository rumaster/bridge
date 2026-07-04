import type { NotificationCategory, NotificationChannel } from "../api/client/types";

/**
 * UI-хелперы раздела Notification (C10, CP-8, ТЗ §15.4). UI отображает ленту,
 * отмечает «прочитано» и управляет настройками категорий/каналов — генерация и
 * доставка уведомлений вне UI (ТЗ §21.5). Детерминированно, без Math.random.
 */
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "info",
  "warning",
  "error",
  "critical",
  "admin"
];

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ["web", "telegram", "email", "push"];

export function notificationCategoryLabel(category: NotificationCategory): string {
  switch (category) {
    case "info":
      return "Информация";
    case "warning":
      return "Предупреждение";
    case "error":
      return "Ошибка";
    case "critical":
      return "Критично";
    case "admin":
      return "Администрирование";
  }
}

/**
 * Тон бейджа категории. Ui-kit saas-admin поддерживает только
 * neutral/success/warning — критичные категории отображаются как warning.
 */
export function notificationCategoryTone(
  category: NotificationCategory
): "neutral" | "success" | "warning" {
  switch (category) {
    case "error":
    case "critical":
    case "warning":
      return "warning";
    case "admin":
      return "neutral";
    case "info":
      return "neutral";
  }
}

export function notificationChannelLabel(channel: NotificationChannel): string {
  switch (channel) {
    case "web":
      return "Веб";
    case "telegram":
      return "Telegram";
    case "email":
      return "Email";
    case "push":
      return "Push";
  }
}

export function notificationSettingKey(
  category: NotificationCategory,
  channel: NotificationChannel
): string {
  return `${category}:${channel}`;
}
