import { createHash } from "node:crypto";

import { createBroadcastCoreDeliveryDraft } from "../../../../packages/contracts/src/c8.js";

import { renderTemplate } from "./template-renderer.js";

/**
 * Идемпотентная генерация сообщений кампании в канонической форме ядра
 * (C1, ТЗ §11.12, §14.3, §14.5).
 *
 * Для каждого получателя формируется **детерминированный** `message_id`,
 * производный от (кампания, получатель, ключ запуска). Отсюда:
 *   - повторный `:start` той же кампании с тем же `idempotency_key` даёт те же
 *     `message_id` → ядро дедуплицирует по `message_id` и не создаёт дублей;
 *   - `idempotency_key = message_id` (сквозной ключ, ТЗ §11.12), это
 *     гарантирует `createBroadcastCoreDeliveryDraft` (C8).
 *
 * SVC-BCAST **не доставляет** сам: фабрика лишь готовит канонический C1-черновик
 * (`C8.BroadcastCoreDeliveryDraft`), который уходит в ядро через C1/C2.
 */

/**
 * @typedef {object} CampaignRecipient
 * @property {string} client_id Идентификатор клиента (сегмент, ТЗ §14.4).
 * @property {string} endpoint_id UUID Endpoint (канал связи клиента).
 * @property {string} conversation_id UUID диалога ядра.
 * @property {string} channel Канал доставки (`telegram`, `web_chat`, ...).
 * @property {number} [sequence_number] Позиция в диалоге (по умолчанию 1).
 * @property {Record<string, unknown>} [context] Контекст персонализации.
 */

/**
 * Детерминированный UUIDv4-совместимый идентификатор из набора частей.
 * Совпадает по алгоритму с ядром/моками, чтобы `message_id` был предсказуем.
 */
export function deriveDeterministicUuid(parts) {
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

/**
 * `message_id` получателя кампании — детерминирован и уникален в рамках
 * (кампания, получатель, запуск).
 */
export function deriveMessageId({ broadcastId, recipient, startIdempotencyKey }) {
  return deriveDeterministicUuid([
    "broadcast-message",
    broadcastId,
    recipient.client_id,
    recipient.endpoint_id,
    startIdempotencyKey,
  ]);
}

/**
 * Строит канонический C1-черновик доставки кампании (C8) для одного получателя.
 *
 * @param {object} params
 * @param {object} params.broadcast Кампания (`organization_id`, `template`, ...).
 * @param {CampaignRecipient} params.recipient Материализованный получатель сегмента.
 * @param {string} params.startIdempotencyKey Ключ идемпотентности запуска кампании.
 * @param {string} params.createdAt ISO-8601 отметка формирования.
 * @returns {{ draft: object, message_id: string, rendered: object }}
 */
export function buildBroadcastDraft({
  broadcast,
  recipient,
  startIdempotencyKey,
  createdAt,
}) {
  if (!broadcast || typeof broadcast !== "object") {
    throw new TypeError("broadcast must be an object");
  }
  assertNonEmptyString(recipient?.client_id, "recipient.client_id");
  assertNonEmptyString(recipient?.endpoint_id, "recipient.endpoint_id");
  assertNonEmptyString(recipient?.conversation_id, "recipient.conversation_id");
  assertNonEmptyString(recipient?.channel, "recipient.channel");
  assertNonEmptyString(startIdempotencyKey, "startIdempotencyKey");

  const rendered = renderTemplate(broadcast.template, recipient.context ?? {});
  const messageId = deriveMessageId({
    broadcastId: broadcast.id,
    recipient,
    startIdempotencyKey,
  });

  const draft = createBroadcastCoreDeliveryDraft({
    broadcastId: broadcast.id,
    organizationId: broadcast.organization_id,
    messageId,
    conversationId: recipient.conversation_id,
    endpointId: recipient.endpoint_id,
    channel: recipient.channel,
    text: rendered.text,
    sequenceNumber: recipient.sequence_number ?? 1,
    createdAt,
  });

  return { draft, message_id: messageId, rendered };
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
