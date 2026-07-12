import { createHash } from "node:crypto";

/**
 * Детерминированный UUID (версия 4, вариант 8) из произвольной строки (md5).
 *
 * Алгоритм совпадает с backend `uuidFromText`
 * (`services/backend/src/modules/communication-core/internal-messaging.dto.ts`) и
 * SVC-INT `inbound/ids.ts`: ядро принимает `message.id` и edge `endpoint_id`
 * только как строгий UUID (C1/C2 UUID_PATTERN), поэтому внешние ссылки email
 * (Message-ID, адрес) должны детерминированно разворачиваться в UUID — стабильно
 * (тот же вход → тот же UUID), что сохраняет идемпотентность приёма (Этап E3).
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
 * Стабильный UUID входящего письма: детерминирован по каналу и заголовку
 * `Message-ID`. Повторная выборка того же письма по IMAP даёт тот же `message_id`,
 * поэтому ядро (acceptIngress, идемпотентно по `message.id`) и RF-буфер Edge
 * (дедуп по `idempotency_key`) не создают дублей.
 */
export function stableEmailMessageId(channelId: string, messageIdHeader: string): string {
  return uuidFromText(`email-message:${channelId}:${messageIdHeader}`);
}

/**
 * Стабильный UUID edge-endpoint email-клиента (ключ партиционирования/
 * секвенирования Edge). Не обязан совпадать с DB-endpoint ядра (ядро повторно
 * резолвит endpoint по `channel_id`+`sender_ref` из C2), но должен быть стабилен
 * для одного адреса, чтобы Edge упорядочивал его сообщения.
 */
export function stableEmailEndpointId(channelId: string, senderRef: string): string {
  return uuidFromText(`email-endpoint:${channelId}:${senderRef}`);
}

/**
 * Стабильный UUID входящего MAX-сообщения на Edge (Этап M4,
 * docs/plan/max-channel-production.md): детерминирован по каналу и `mid`
 * (id сообщения MAX Bot API). Переопрос того же сообщения (переигранный marker)
 * даёт тот же `message_id` — ядро (идемпотентно по `message.id`) и RF-буфер Edge
 * (дедуп по `idempotency_key`) не создают дублей. Идентичен app-side
 * `stableMaxMessageId` (SVC-INT `inbound/ids.ts`): один и тот же `mid` даёт один
 * UUID независимо от пути (app/edge) — идемпотентность сохраняется при миграции.
 */
export function stableMaxMessageId(channelId: string, messageRef: number | string): string {
  return uuidFromText(`max-message:${channelId}:${messageRef}`);
}

/** Стабильный UUID edge-endpoint MAX-клиента (ключ партиционирования Edge). */
export function stableMaxEndpointId(channelId: string, senderRef: string): string {
  return uuidFromText(`max-endpoint:${channelId}:${senderRef}`);
}
