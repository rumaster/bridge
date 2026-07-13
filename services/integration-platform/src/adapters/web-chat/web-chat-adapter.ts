import { randomUUID } from "node:crypto";

import {
  C6_CAPABILITIES,
  createCapabilityDescriptor,
  validateCapabilityDescriptor,
} from "../../../../../packages/contracts/src/c6.js";

const C2_VERSION = "1.0.0";
export const WEB_CHAT_CHANNEL_TYPE = "web_chat";
const WEB_CHAT_ADAPTER_NAME = "web-chat-adapter";
const WEB_CHAT_SUPPORTED_CAPABILITIES = new Set([
  "text",
  "image",
  "file",
  "typing_indicator",
  "read_receipt",
]);
const WEB_CHAT_MESSAGE_TYPES = new Set(["text", "image", "file"]);

/** Опции {@link createWebChatAdapter}. */
export interface WebChatAdapterOptions {
  coreIngressUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
}

/**
 * Адаптер Web Chat — **inbound/C6-only**. У Web Chat нет внешнего канала доставки:
 * клиент подключён напрямую к ядру по REST/C7-WS, поэтому исходящее доставляется
 * публикацией C7-события ядром, а НЕ egress-адаптером (WG-6/WG-7,
 * docs/plan/web-chat-channel-production.md, этап W1). Здесь остаются только приём
 * (нормализация входящего → C2.IngressMessage) и C6 capability-дескриптор; egress
 * из адаптера снят и в движок доставки SVC-INT он не регистрируется.
 */
export function createWebChatAdapter({
  coreIngressUrl,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
}: WebChatAdapterOptions = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const metrics = {
    ingress_published_total: 0,
    ingress_failed_total: 0,
  };

  const capabilityDescriptor = createWebChatCapabilityDescriptor({
    generatedAt: now(),
  });

  return {
    capabilityDescriptor,

    getMetrics() {
      return { ...metrics };
    },

    async emulateIncomingMessage(payload) {
      return this.publishIncomingMessage(payload);
    },

    async publishIncomingMessage(payload) {
      if (typeof coreIngressUrl !== "string" || coreIngressUrl.trim() === "") {
        throw new Error("coreIngressUrl is required to publish C2 Ingress");
      }

      const message = normalizeIncomingWebChatMessage(payload, now);
      const ingress = {
        contract: "C2.IngressMessage",
        version: C2_VERSION,
        idempotency_key: message.message_id,
        received_at: now(),
        message,
      };

      const response = await fetchImpl(coreIngressUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ingress),
      });

      if (!response.ok) {
        metrics.ingress_failed_total += 1;
        throw new Error(`C2 Ingress rejected with HTTP ${response.status}`);
      }

      metrics.ingress_published_total += 1;

      return {
        accepted: true,
        core_status: response.status,
        ingress,
      };
    },
  };
}

/** Опции {@link createWebChatCapabilityDescriptor}. */
export interface WebChatCapabilityDescriptorOptions {
  channelId?: any;
  generatedAt?: string;
}

export function createWebChatCapabilityDescriptor({
  channelId,
  generatedAt = new Date().toISOString(),
}: WebChatCapabilityDescriptorOptions = {}) {
  const descriptor = createCapabilityDescriptor({
    channelType: WEB_CHAT_CHANNEL_TYPE,
    channelId,
    adapterName: WEB_CHAT_ADAPTER_NAME,
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        createCapability(capability),
      ]),
    ),
    generatedAt,
  });

  const validation = validateCapabilityDescriptor(descriptor);
  if (!validation.valid) {
    throw new Error(`Invalid Web Chat C6 descriptor: ${validation.errors.join("; ")}`);
  }

  return descriptor;
}

export function normalizeIncomingWebChatMessage(payload, now = () => new Date().toISOString()) {
  const errors = [];
  expectRecord(errors, payload, "payload");

  const normalized = normalizeIncomingPayload(payload);
  expectNonEmptyString(errors, normalized.organizationId, "organization_id");
  expectNonEmptyString(errors, normalized.channelId, "channel_id or endpoint_id");
  expectNonEmptyString(
    errors,
    normalized.sessionId,
    "session_id, conversation_ref, or conversation_id",
  );
  expectNonEmptyString(errors, normalized.senderRef, "sender_ref or visitor_session_id");

  if (normalized.text !== undefined && typeof normalized.text !== "string") {
    errors.push("text must be a string");
  }

  const attachments = normalizeAttachments(normalized.attachments, errors);
  if ((normalized.text ?? "") === "" && attachments.length === 0) {
    errors.push("text or attachments are required");
  }

  if (
    typeof normalized.messageId === "string" &&
    typeof normalized.idempotencyKey === "string" &&
    normalized.messageId !== normalized.idempotencyKey
  ) {
    errors.push("idempotency_key must match message_id");
  }

  if (errors.length > 0) {
    throw new TypeError(errors.join("; "));
  }

  const messageId =
    normalized.messageId ?? normalized.idempotencyKey ?? `web-chat-in-${randomUUID()}`;
  const contentType = inferContentType(normalized, attachments);
  const occurredAt = normalized.occurredAt ?? now();

  return {
    message_id: messageId,
    idempotency_key: messageId,
    organization_id: normalized.organizationId,
    channel_id: normalized.channelId,
    channel_type: WEB_CHAT_CHANNEL_TYPE,
    external_message_id: normalized.externalMessageId ?? messageId,
    conversation_ref: normalized.sessionId,
    sender_ref: normalized.senderRef,
    direction: "inbound",
    content: {
      type: contentType,
      ...(normalized.text !== undefined && normalized.text !== ""
        ? { text: normalized.text }
        : {}),
    },
    attachments,
    occurred_at: occurredAt,
  };
}

function createCapability(capability) {
  if (WEB_CHAT_SUPPORTED_CAPABILITIES.has(capability)) {
    return { supported: true };
  }

  return {
    supported: false,
    notes: "Not supported by the M1 Web Chat adapter.",
  };
}

function normalizeIncomingPayload(payload) {
  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id ?? payload?.endpoint_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    sessionId:
      payload?.session_id ?? payload?.conversation_ref ?? payload?.conversation_id,
    senderRef: payload?.sender_ref ?? payload?.visitor_session_id,
    text: payload?.text ?? payload?.body?.text,
    type: payload?.type ?? payload?.body?.type,
    attachments: payload?.attachments ?? payload?.body?.attachments ?? [],
    externalMessageId: payload?.external_message_id,
    occurredAt: payload?.occurred_at,
  };
}

function inferContentType(payload, attachments) {
  if (payload.type !== undefined) {
    if (!WEB_CHAT_MESSAGE_TYPES.has(payload.type)) {
      throw new TypeError("type must be one of: text, image, file");
    }
    return payload.type;
  }

  if (payload.text !== undefined && payload.text !== "") {
    return "text";
  }

  return attachments[0]?.kind ?? "text";
}

function normalizeAttachments(attachments, errors) {
  if (!Array.isArray(attachments)) {
    errors.push("attachments must be an array");
    return [];
  }

  return attachments.map((attachment, index) => {
    expectRecord(errors, attachment, `attachments[${index}]`);
    expectNonEmptyString(errors, attachment?.id, `attachments[${index}].id`);
    expectNonEmptyString(errors, attachment?.kind, `attachments[${index}].kind`);
    expectNonEmptyString(
      errors,
      attachment?.storage_ref,
      `attachments[${index}].storage_ref`,
    );
    expectNonEmptyString(errors, attachment?.mime, `attachments[${index}].mime`);

    if (!["image", "file"].includes(attachment?.kind)) {
      errors.push(`attachments[${index}].kind must be image or file`);
    }

    if (
      attachment?.size !== undefined &&
      (!Number.isSafeInteger(attachment.size) || attachment.size < 0)
    ) {
      errors.push(`attachments[${index}].size must be a non-negative integer`);
    }

    return {
      id: attachment.id,
      kind: attachment.kind,
      storage_ref: attachment.storage_ref,
      mime: attachment.mime,
      ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    };
  });
}

function expectRecord(errors, value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
  }
}

function expectNonEmptyString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}
