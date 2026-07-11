import { createHash } from "node:crypto";

/**
 * Детерминированный UUID (версия 4, вариант 8) из произвольной строки на базе md5.
 *
 * Алгоритм совпадает с backend `uuidFromText`
 * (services/backend/src/modules/communication-core/internal-messaging.dto.ts):
 * ядро принимает `message.message_id` / edge `endpoint_id` только как строгий UUID
 * (C1/C2 UUID_PATTERN), поэтому не-UUID внешние ссылки Telegram
 * (`tg-<channel>-<update_id>`, `chat.id`) должны детерминированно
 * разворачиваться в UUID — стабильно (тот же вход → тот же UUID), что сохраняет
 * идемпотентность приёма (Этап T5, docs/plan/telegram-channel-production.md).
 */
export function uuidFromText(value: string): string {
  const hex = createHash("md5").update(String(value)).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Стабильный UUID входящего Telegram-сообщения: детерминирован по каналу и
 * `update_id`, поэтому повтор апдейта даёт тот же `message_id` и не двоит запись
 * (идемпотентность acceptIngress по message.id). Читаемая форма
 * `tg-<channel>-<update_id>` сохраняется в `external_message_id`/трейсинге.
 */
export function stableTelegramMessageId(channelId: string, updateId: number | string): string {
  return uuidFromText(`tg-message:${channelId}:${updateId}`);
}

/**
 * Стабильный UUID edge-endpoint (ключ партиционирования/секвенирования Edge).
 * Edge tunnel требует UUID `endpoint_id`; он не обязан совпадать с DB-endpoint
 * ядра (ядро повторно резолвит endpoint по `channel_id`+`sender_ref` из C2), но
 * должен быть стабилен для одного клиента, чтобы Edge упорядочивал его сообщения.
 */
export function stableEdgeEndpointId(channelId: string, senderRef: string): string {
  return uuidFromText(`tg-endpoint:${channelId}:${senderRef}`);
}
