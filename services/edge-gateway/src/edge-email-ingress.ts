import { stableEmailEndpointId, stableEmailMessageId, uuidFromText } from "./edge-ids.js";

/**
 * Нормализация входящего письма в конверт C2.IngressMessage на Edge (Этап E3
 * плана `docs/plan/email-channel-production.md`).
 *
 * Порт inbound-логики SVC-INT email-адаптера
 * (`services/integration-platform/src/adapters/email/email-adapter.ts` +
 * `adapters/common/m2-channel-adapter.ts`) на Edge: по решению 1 email —
 * Edge-owned, приём письма живёт на Edge, а не на app-стороне. Форма выхода
 * идентична SVC-INT (`normalizeM2IncomingMessage`), поэтому ядро (`acceptIngress`)
 * обрабатывает его тем же путём. Ядро само резолвит endpoint/conversation по
 * `channel_id`+`sender_ref`; Edge лишь добавляет поля верхнего уровня
 * (`id`/`endpoint_id`/`idempotency_key`) для RF-секвенирования буфера.
 */

const C2_VERSION = "1.0.0";
const ATTACHMENT_KINDS = new Set(["image", "file", "voice", "video"]);

/** Апдейт не пригоден для приёма (нет ни текста, ни вложений и т.п.). */
export class NonIngestibleEmailError extends Error {
  readonly nonIngestible = true;
  constructor(message: string) {
    super(message);
    this.name = "NonIngestibleEmailError";
  }
}

export interface RawEmailAttachment {
  id?: string;
  content_id?: string;
  filename?: string;
  storage_ref?: string;
  /** sha256 сохранённых байтов (дедуп/аудит); едет в metadata вложения ядра. */
  content_hash?: string;
  mime?: string;
  mime_type?: string;
  kind?: string;
  size?: number;
}

export interface RawEmail {
  /** IMAP UID — курсор выборки (монотонный в пределах ящика). */
  uid?: number;
  message_id?: string;
  id?: string;
  from?: string;
  sender?: string;
  subject?: string;
  text?: string;
  text_body?: string;
  html?: string;
  thread_id?: string;
  date?: string;
  attachments?: RawEmailAttachment[];
}

export interface BuildEmailIngressInput {
  email: RawEmail;
  organizationId: string;
  channelId: string;
  now?: () => string;
}

/**
 * Строит тело приёма для `EdgeCluster.ingest`: конверт C2.IngressMessage плюс
 * поля верхнего уровня `id`/`idempotency_key`/`endpoint_id`. Бросает
 * {@link NonIngestibleEmailError}, если письмо не пригодно для приёма.
 */
export function buildEmailIngress({
  email,
  organizationId,
  channelId,
  now = () => new Date().toISOString(),
}: BuildEmailIngressInput) {
  if (!organizationId || !channelId) {
    throw new NonIngestibleEmailError("organization_id and channel_id are required");
  }

  const from = firstNonEmptyString(email?.from, email?.sender);
  if (!from) {
    throw new NonIngestibleEmailError("email sender (from) is required");
  }

  const messageIdHeader = firstNonEmptyString(email?.message_id, email?.id) ?? `${channelId}:${from}`;
  const messageId = stableEmailMessageId(channelId, messageIdHeader);

  const text = firstNonEmptyString(email?.text, email?.text_body, email?.html, email?.subject);
  // id вложения детерминирован по (messageId, ссылка вложения): повторная выборка
  // того же письма даёт те же id — ядро (attachments PK) идемпотентно, дублей нет.
  const attachments = normalizeAttachments(email?.attachments ?? [], messageId);
  if ((text ?? "") === "" && attachments.length === 0) {
    throw new NonIngestibleEmailError("email has neither text nor attachments");
  }

  const conversationRef = firstNonEmptyString(email?.thread_id, from) as string;
  const occurredAt = firstNonEmptyString(email?.date) ?? now();

  const content = {
    type: attachments.length > 0 && (text ?? "") === "" ? attachments[0].kind : "text",
    ...(text !== undefined && text !== "" ? { text } : {}),
  };

  const message = {
    message_id: messageId,
    idempotency_key: messageId,
    organization_id: organizationId,
    channel_id: channelId,
    channel_type: "email",
    external_message_id: messageIdHeader,
    conversation_ref: conversationRef,
    sender_ref: from,
    direction: "inbound",
    content,
    attachments,
    occurred_at: occurredAt,
    identity: { type: "verified_email", value: from },
  };

  return {
    contract: "C2.IngressMessage",
    version: C2_VERSION,
    idempotency_key: messageId,
    received_at: now(),
    message,
    // Поля верхнего уровня для RF-буфера Edge (секвенирование/идемпотентность).
    id: messageId,
    endpoint_id: stableEmailEndpointId(channelId, from),
  };
}

function normalizeAttachments(attachments: RawEmailAttachment[], messageId: string) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.map((attachment, index) => {
    const mime = attachment.mime ?? attachment.mime_type ?? "application/octet-stream";
    // Логическая ссылка вложения (стабильна в пределах письма); при отсутствии —
    // позиция. Разворачиваем в UUID: ядро (attachments.id — uuid PK) не примет
    // произвольную строку, а детерминизм сохраняет идемпотентность повторов.
    const ref =
      firstNonEmptyString(attachment.id, attachment.content_id, attachment.filename) ??
      `index-${index}`;
    const id = uuidFromText(`email-attachment:${messageId}:${ref}`);
    const kind = attachment.kind && ATTACHMENT_KINDS.has(attachment.kind)
      ? attachment.kind
      : attachmentKindFromMime(mime);

    return {
      id,
      kind,
      // Реальный ref из хранилища Edge, либо (нет байтов/стора) — прежняя
      // непрозрачная заглушка, которая просто не зарезолвится на выдаче.
      storage_ref: attachment.storage_ref ?? `email-attachment://${id}`,
      mime,
      ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
      ...(attachment.content_hash !== undefined ? { content_hash: attachment.content_hash } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    };
  });
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}
