import { stableMaxEndpointId, stableMaxMessageId } from "./edge-ids.js";

/**
 * Нормализация входящего MAX-апдейта в конверт C2.IngressMessage на Edge (Этап M4
 * плана `docs/plan/max-channel-production.md`).
 *
 * Порт inbound-логики SVC-INT MAX-адаптера
 * (`services/integration-platform/src/adapters/max/max-adapter.ts`) на Edge: по
 * требованию «бот max на edge» приём живёт на Edge (как email), а не app-side.
 * Форма выхода идентична SVC-INT (`normalizeM2IncomingMessage`), поэтому ядро
 * (`acceptIngress`) обрабатывает его тем же путём. Ядро само резолвит
 * endpoint/conversation по `channel_id`+`sender_ref`; Edge лишь добавляет поля
 * верхнего уровня (`id`/`endpoint_id`/`idempotency_key`) для RF-секвенирования.
 */

const C2_VERSION = "1.0.0";
const ATTACHMENT_KINDS = new Set(["image", "file", "voice", "video"]);

/** Апдейт не пригоден для приёма (сервисное событие MAX, нет текста/вложений). */
export class NonIngestibleMaxUpdateError extends Error {
  readonly nonIngestible = true;
  constructor(message: string) {
    super(message);
    this.name = "NonIngestibleMaxUpdateError";
  }
}

export interface BuildMaxIngressInput {
  update: any;
  organizationId: string;
  channelId: string;
  now?: () => string;
}

/**
 * Строит тело приёма для `EdgeCluster.ingest`: конверт C2.IngressMessage плюс поля
 * верхнего уровня `id`/`idempotency_key`/`endpoint_id`. Бросает
 * {@link NonIngestibleMaxUpdateError}, если апдейт не пригоден для приёма.
 */
export function buildMaxIngress({
  update,
  organizationId,
  channelId,
  now = () => new Date().toISOString(),
}: BuildMaxIngressInput) {
  if (!organizationId || !channelId) {
    throw new NonIngestibleMaxUpdateError("organization_id and channel_id are required");
  }

  const message = update?.message ?? update ?? {};
  const sender = message.sender ?? message.from ?? {};
  const recipient = message.recipient ?? {};
  const body = message.body ?? {};

  const senderRef = firstNonEmptyString(sender.user_id, sender.id);
  if (!senderRef) {
    throw new NonIngestibleMaxUpdateError("MAX message sender (user_id) is required");
  }

  const text = firstNonEmptyString(body.text, message.text);
  const attachments = normalizeAttachments(body.attachments ?? message.attachments ?? []);
  if ((text ?? "") === "" && attachments.length === 0) {
    throw new NonIngestibleMaxUpdateError("MAX update has neither text nor attachments");
  }

  const mid = firstNonEmptyString(body.mid, message.mid, message.id);
  const externalMessageId = mid ?? `${channelId}:${senderRef}`;
  const messageId = stableMaxMessageId(channelId, externalMessageId);
  const conversationRef = firstNonEmptyString(
    recipient.chat_id,
    message.chat_id,
    message.dialog_id,
    senderRef,
  ) as string;
  const occurredAt =
    normalizeTimestamp(message.timestamp ?? update?.timestamp) ??
    firstNonEmptyString(message.created_at) ??
    now();

  const content = {
    type: attachments.length > 0 && (text ?? "") === "" ? attachments[0].kind : "text",
    ...(text !== undefined && text !== "" ? { text } : {}),
  };

  const normalizedMessage = {
    message_id: messageId,
    idempotency_key: messageId,
    organization_id: organizationId,
    channel_id: channelId,
    channel_type: "max",
    external_message_id: externalMessageId,
    conversation_ref: conversationRef,
    sender_ref: senderRef,
    direction: "inbound",
    content,
    attachments,
    occurred_at: occurredAt,
    identity: { type: "max_user", value: senderRef },
  };

  return {
    contract: "C2.IngressMessage",
    version: C2_VERSION,
    idempotency_key: messageId,
    received_at: now(),
    message: normalizedMessage,
    // Поля верхнего уровня для RF-буфера Edge (секвенирование/идемпотентность).
    id: messageId,
    endpoint_id: stableMaxEndpointId(channelId, senderRef),
  };
}

function normalizeAttachments(attachments: any[]) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.map((attachment) => {
    const mime = attachment.mime ?? attachment.mime_type ?? mimeForType(attachment.type);
    const id =
      firstNonEmptyString(attachment.id, attachment.url, attachment.storage_ref) ??
      `max-attachment-${Math.abs(hashString(JSON.stringify(attachment)))}`;
    const kind =
      attachment.kind && ATTACHMENT_KINDS.has(attachment.kind)
        ? attachment.kind
        : kindForType(attachment.type, mime);

    return {
      id,
      kind,
      storage_ref: attachment.storage_ref ?? attachment.url ?? `max-attachment://${id}`,
      mime,
      ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    };
  });
}

function kindForType(type: string | undefined, mime: string): string {
  if (type === "image" || type === "photo") {
    return "image";
  }
  if (type === "video") {
    return "video";
  }
  if (type === "voice" || type === "audio") {
    return "voice";
  }
  return attachmentKindFromMime(mime);
}

function mimeForType(type: string | undefined): string {
  if (type === "image" || type === "photo") {
    return "image/jpeg";
  }
  if (type === "video") {
    return "video/mp4";
  }
  if (type === "voice" || type === "audio") {
    return "audio/ogg";
  }
  return "application/octet-stream";
}

function attachmentKindFromMime(mime: string): string {
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "voice";
  }
  return "file";
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value as number).toISOString();
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
