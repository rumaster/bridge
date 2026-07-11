/**
 * Диспетчер проактивных уведомлений Telegram Console (G-8,
 * docs/plan/telegram-channel-production.md, Этап T4 задача 4).
 *
 * Связывает боевой поток уведомлений с уже существующим
 * `router.deliverNotification({ chatId, notification })`: принимает C10-уведомление
 * (из SVC-NOTIF по HTTP или из потока), резолвит chat_id менеджера и доставляет
 * карточку. Резолв chat_id по умолчанию:
 *   1) явный `notification.payload.telegram_chat_id` / `chat_id` (если продюсер знает чат);
 *   2) обратный поиск в session-store по `recipient_user_id` (привязанная сессия менеджера).
 * Нет привязанного чата → `skipped` (карточка не доставляется, но это не ошибка).
 */

export interface TelegramConsoleNotificationDispatcherOptions {
  router: { deliverNotification: (input: { chatId: unknown; notification: any }) => Promise<any> };
  sessionStore?: { findChatIdByUserId?: (userId: unknown) => unknown };
  resolveChatId?: (notification: any) => unknown | Promise<unknown>;
  logger?: any;
}

export function createTelegramConsoleNotificationDispatcher({
  router,
  sessionStore,
  resolveChatId,
  logger = console,
}: TelegramConsoleNotificationDispatcherOptions) {
  if (!router || typeof router.deliverNotification !== "function") {
    throw new TypeError("router with deliverNotification is required");
  }

  const resolve =
    resolveChatId ??
    ((notification: any) => {
      const explicit =
        notification?.payload?.telegram_chat_id ?? notification?.payload?.chat_id ?? null;
      if (explicit !== undefined && explicit !== null && String(explicit) !== "") {
        return explicit;
      }
      if (sessionStore && typeof sessionStore.findChatIdByUserId === "function") {
        return sessionStore.findChatIdByUserId(notification?.recipient_user_id);
      }
      return null;
    });

  return {
    async deliver(notification: any) {
      if (!notification || typeof notification !== "object") {
        throw new TypeError("notification must be an object");
      }

      if (!Array.isArray(notification.channels) || !notification.channels.includes("telegram")) {
        return skipped(notification, "telegram-channel-not-enabled");
      }

      const chatId = await resolve(notification);
      if (chatId === undefined || chatId === null || String(chatId) === "") {
        logger?.warn?.("No linked Telegram chat for notification recipient", {
          notification_id: notification.id,
          recipient_user_id: notification.recipient_user_id,
        });
        return skipped(notification, "no-linked-chat");
      }

      return router.deliverNotification({ chatId, notification });
    },
  };
}

function skipped(notification: any, reason: string) {
  return {
    route: "notification:telegram",
    status: "skipped",
    reason,
    notification_id: notification?.id,
    blocks_m0_gate: false,
    blocks_cp1: false,
  };
}
