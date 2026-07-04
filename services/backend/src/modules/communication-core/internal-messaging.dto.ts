/**
 * Контракты внутреннего messaging-пути (C2) для production-сборки backend.
 *
 * Нормализация ingress/egress-конвертов и построение C2.EgressDelivery
 * портированы из прототипа `communication-core-m1.mjs`
 * (`normalizeC2IngressEnvelope`, `buildC2EgressDelivery`, `normalizeChannel`,
 * `normalizeMessageType`, `uuidFromText`) в исполняемый TypeScript, который
 * компилируется в `dist/main.js`. Ранее эта логика жила только в `.mjs`, не
 * попадала в prod и приводила к 404 на `POST /internal/ingress/messages`
 * (см. issue #189, пункты 1–3).
 */

import { createHash } from "node:crypto";

import { BadRequestException } from "@nestjs/common";

import { MESSAGE_DIRECTION } from "./message-status";

export const C2_VERSION = "1.0.0";
export const C2_INGRESS_CONTRACT = "C2.IngressMessage";
export const C2_EGRESS_CONTRACT = "C2.EgressDelivery";
export const C2_DELIVERY_ATTEMPT_CONTRACT = "C2.DeliveryAttempt";

/**
 * Паттерн UUID контракта C1/C2 (версии 1–8, вариант 89ab) — совпадает с
 * `UUID_PATTERN` в `packages/contracts/message-model/index.mjs`.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const VALID_CHANNELS = Object.freeze([
  "telegram",
  "max",
  "vk",
  "whatsapp",
  "web_chat",
  "email",
  "sms",
] as const);

export const VALID_MESSAGE_TYPES = Object.freeze([
  "text",
  "image",
  "file",
  "audio",
  "video",
  "location",
  "command",
  "event",
  "system",
] as const);

export const DELIVERY_ATTEMPT_STATUSES = Object.freeze([
  "pending",
  "sent",
  "delivered",
  "failed",
] as const);

export type DeliveryAttemptStatus = (typeof DELIVERY_ATTEMPT_STATUSES)[number];

export interface IngressEnvelope {
  contract?: unknown;
  version?: unknown;
  idempotency_key?: unknown;
  received_at?: unknown;
  message?: {
    message_id?: unknown;
    organization_id?: unknown;
    channel_id?: unknown;
    channel_type?: unknown;
    conversation_ref?: unknown;
    sender_ref?: unknown;
    direction?: unknown;
    occurred_at?: unknown;
    sequence_number?: unknown;
    content?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NormalizedIngress {
  idempotencyKey: string;
  organizationId: string;
  channel: string;
  channelId: string;
  endpointExternalId: string;
  conversationRef: string | null;
  senderRef: string | null;
  occurredAt: string;
  routedAt: string;
  message: {
    id: string;
    type: string;
    content: Record<string, unknown>;
    sequenceNumber: number | null;
  };
}

export interface EgressRequestBody {
  organization_id?: unknown;
  message_id?: unknown;
  adapter?: unknown;
  adapter_endpoint_id?: unknown;
  [key: string]: unknown;
}

export interface NormalizedEgressRequest {
  organizationId: string;
  messageId: string;
  adapter: string;
  adapterEndpointId: string | null;
}

export interface DeliveryAttemptBody {
  contract?: unknown;
  version?: unknown;
  organization_id?: unknown;
  message_id?: unknown;
  adapter?: unknown;
  attempt_no?: unknown;
  status?: unknown;
  error?: unknown;
  occurred_at?: unknown;
  [key: string]: unknown;
}

export interface NormalizedDeliveryAttempt {
  organizationId: string;
  messageId: string;
  adapter: string;
  attemptNo: number;
  status: DeliveryAttemptStatus;
  error: string | null;
  occurredAt: string;
}

function messagingBadRequest(description: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED",
    description,
    humanMessage: "Некорректный конверт messaging-контракта.",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Детерминированный UUID (версия 4) из произвольной строки на базе md5 —
 * портирован из `uuidFromText` прототипа m1, чтобы совпадали идентификаторы
 * клиентов/endpoint-ов для не-UUID внешних ссылок (mock-каналы).
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

function assertUuidOrDerive(value: unknown, field: string): string {
  if (isUuid(value)) {
    return value;
  }
  if (!isNonBlankString(value)) {
    throw messagingBadRequest(`${field} is required.`);
  }

  return uuidFromText(`${field}:${value}`);
}

function toMessageUuid(value: unknown, fallback: string): string {
  if (isUuid(value)) {
    return value;
  }

  return uuidFromText(`message:${isNonBlankString(value) ? value : fallback}`);
}

export function normalizeChannel(channel: unknown): string {
  const normalized = channel === "mock" ? "web_chat" : channel;
  if (typeof normalized !== "string" || !VALID_CHANNELS.includes(normalized as never)) {
    throw messagingBadRequest(`Unsupported channel: ${String(channel)}`);
  }

  return normalized;
}

export function normalizeMessageType(type: unknown): string {
  const normalized = type === "voice" ? "audio" : type;
  if (typeof normalized !== "string" || !VALID_MESSAGE_TYPES.includes(normalized as never)) {
    throw messagingBadRequest(`Unsupported message type: ${String(type)}`);
  }

  return normalized;
}

function normalizeTimestamp(value: unknown): string {
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw messagingBadRequest("Timestamp must be a valid date-time.");
  }

  return date.toISOString();
}

/**
 * Нормализует конверт C2.IngressMessage. Портирован из
 * `normalizeC2IngressEnvelope` (communication-core-m1.mjs).
 */
export function normalizeIngressEnvelope(
  payload: IngressEnvelope,
  now: () => string,
): NormalizedIngress {
  const errors: string[] = [];
  if (payload.contract !== undefined && payload.contract !== C2_INGRESS_CONTRACT) {
    errors.push(`contract must equal ${JSON.stringify(C2_INGRESS_CONTRACT)}`);
  }
  if (payload.version !== C2_VERSION) {
    errors.push(`version must equal ${JSON.stringify(C2_VERSION)}`);
  }
  if (!isNonBlankString(payload.idempotency_key)) {
    errors.push("idempotency_key must be a non-empty string");
  }
  if (!isPlainObject(payload.message)) {
    errors.push("message must be an object");
  }

  const message = isPlainObject(payload.message) ? payload.message : {};
  if (!isNonBlankString(message.message_id)) {
    errors.push("message.message_id must be a non-empty string");
  }
  if (!isNonBlankString(message.organization_id)) {
    errors.push("message.organization_id must be a non-empty string");
  }
  if (!isNonBlankString(message.channel_id)) {
    errors.push("message.channel_id must be a non-empty string");
  }
  if (!isNonBlankString(message.channel_type)) {
    errors.push("message.channel_type must be a non-empty string");
  }
  if (message.direction !== MESSAGE_DIRECTION.INBOUND) {
    errors.push(`message.direction must equal ${JSON.stringify(MESSAGE_DIRECTION.INBOUND)}`);
  }
  if (!isPlainObject(message.content)) {
    errors.push("message.content must be an object");
  }
  if (
    isNonBlankString(payload.idempotency_key) &&
    isNonBlankString(message.message_id) &&
    payload.idempotency_key !== message.message_id
  ) {
    errors.push("idempotency_key must match message.message_id");
  }
  if (isNonBlankString(payload.idempotency_key) && !isUuid(payload.idempotency_key)) {
    errors.push("idempotency_key must be a UUID string");
  }
  if (isNonBlankString(message.message_id) && !isUuid(message.message_id)) {
    errors.push("message.message_id must be a UUID string");
  }
  if (
    message.sequence_number !== undefined &&
    message.sequence_number !== null &&
    (!Number.isSafeInteger(message.sequence_number) ||
      (message.sequence_number as number) < 1)
  ) {
    errors.push("message.sequence_number must be a positive integer");
  }

  if (errors.length > 0) {
    throw messagingBadRequest(`Invalid C2 ingress: ${errors.join("; ")}`);
  }

  const organizationId = assertUuidOrDerive(message.organization_id, "message.organization_id");
  const idempotencyKey = String(payload.idempotency_key);
  const messageId = toMessageUuid(message.message_id, idempotencyKey);
  const occurredAt = normalizeTimestamp(message.occurred_at ?? payload.received_at ?? now());
  const channel = normalizeChannel(message.channel_type);
  const content = message.content as Record<string, unknown>;
  const type = normalizeMessageType(content.type);
  const senderRef = isNonBlankString(message.sender_ref) ? message.sender_ref : null;
  const conversationRef = isNonBlankString(message.conversation_ref)
    ? message.conversation_ref
    : null;
  const endpointExternalId = `${String(message.channel_id)}:${
    senderRef ?? conversationRef ?? "anonymous"
  }`;

  return {
    idempotencyKey,
    organizationId,
    channel,
    channelId: String(message.channel_id),
    endpointExternalId,
    conversationRef,
    senderRef,
    occurredAt,
    routedAt: now(),
    message: {
      id: messageId,
      type,
      content: { ...content, type },
      sequenceNumber:
        message.sequence_number === undefined || message.sequence_number === null
          ? null
          : Number(message.sequence_number),
    },
  };
}

/**
 * Нормализует запрос на egress-передачу исходящего сообщения. Тело запроса
 * ссылается на уже сохранённое исходящее сообщение по (organization_id,
 * message_id) — сам конверт C2.EgressDelivery строится сервисом из БД.
 */
export function normalizeEgressRequest(payload: EgressRequestBody): NormalizedEgressRequest {
  if (!isUuid(payload.organization_id)) {
    throw messagingBadRequest("organization_id must be a UUID string");
  }
  if (!isUuid(payload.message_id)) {
    throw messagingBadRequest("message_id must be a UUID string");
  }
  const adapter = isNonBlankString(payload.adapter) ? payload.adapter : "mock";
  const adapterEndpointId = isNonBlankString(payload.adapter_endpoint_id)
    ? payload.adapter_endpoint_id
    : null;

  return {
    organizationId: payload.organization_id,
    messageId: payload.message_id,
    adapter,
    adapterEndpointId,
  };
}

/**
 * Нормализует конверт C2.DeliveryAttempt, которым integration-platform
 * фиксирует ход доставки. Портирован из проверок
 * `backend-delivery-client.mjs` / `recordDeliveryAttemptAndTransition`.
 */
export function normalizeDeliveryAttempt(
  payload: DeliveryAttemptBody,
  now: () => string,
): NormalizedDeliveryAttempt {
  const errors: string[] = [];
  if (payload.contract !== undefined && payload.contract !== C2_DELIVERY_ATTEMPT_CONTRACT) {
    errors.push(`contract must equal ${JSON.stringify(C2_DELIVERY_ATTEMPT_CONTRACT)}`);
  }
  if (!isUuid(payload.organization_id)) {
    errors.push("organization_id must be a UUID string");
  }
  if (!isUuid(payload.message_id)) {
    errors.push("message_id must be a UUID string");
  }
  if (!isNonBlankString(payload.adapter)) {
    errors.push("adapter must be a non-empty string");
  }
  if (!Number.isInteger(payload.attempt_no) || (payload.attempt_no as number) < 1) {
    errors.push("attempt_no must be a positive integer");
  }
  if (!DELIVERY_ATTEMPT_STATUSES.includes(payload.status as never)) {
    errors.push(`status must be one of: ${DELIVERY_ATTEMPT_STATUSES.join(", ")}`);
  }

  if (errors.length > 0) {
    throw messagingBadRequest(`Invalid C2 delivery attempt: ${errors.join("; ")}`);
  }

  return {
    organizationId: payload.organization_id as string,
    messageId: payload.message_id as string,
    adapter: payload.adapter as string,
    attemptNo: payload.attempt_no as number,
    status: payload.status as DeliveryAttemptStatus,
    error: isNonBlankString(payload.error) ? payload.error : null,
    occurredAt: normalizeTimestamp(payload.occurred_at ?? now()),
  };
}

export interface EgressEndpointContext {
  channel: string;
  external_id: string;
  metadata: Record<string, unknown> | null;
}

export interface EgressMessageContext {
  id: string;
  organization_id: string;
  conversation_id: string;
  channel: string;
  type: string;
  content: Record<string, unknown>;
}

export interface C2EgressDelivery {
  contract: string;
  version: string;
  idempotency_key: string;
  channel_id: string;
  message: {
    message_id: string;
    organization_id: string;
    channel_id: string;
    channel_type: string;
    conversation_ref: string;
    direction: string;
    content: Record<string, unknown>;
  };
}

/**
 * Строит конверт C2.EgressDelivery из сохранённого исходящего сообщения и его
 * endpoint-а. Портирован из `buildC2EgressDelivery` (communication-core-m1.mjs).
 */
export function buildC2EgressDelivery(
  message: EgressMessageContext,
  endpoint: EgressEndpointContext,
): C2EgressDelivery {
  const metadata = endpoint.metadata ?? {};
  const channelId = String(
    metadata.channel_id ?? endpoint.external_id ?? message.id,
  );
  const conversationRef = String(
    metadata.conversation_ref ?? message.conversation_id,
  );
  const channelType = endpoint.channel ?? message.channel;

  return {
    contract: C2_EGRESS_CONTRACT,
    version: C2_VERSION,
    idempotency_key: message.id,
    channel_id: channelId,
    message: {
      message_id: message.id,
      organization_id: message.organization_id,
      channel_id: channelId,
      channel_type: channelType,
      conversation_ref: conversationRef,
      direction: MESSAGE_DIRECTION.OUTBOUND,
      content: { ...message.content, type: message.type },
    },
  };
}
