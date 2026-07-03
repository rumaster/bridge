import { randomUUID } from "node:crypto";

import {
  C6_CAPABILITIES,
  createCapabilityDescriptor,
  validateCapabilityDescriptor,
} from "../../../../../packages/contracts/src/c6.mjs";

export const C2_VERSION = "1.0.0";

const ATTACHMENT_KINDS = new Set(["image", "file", "voice", "video"]);

export function createM2ChannelAdapter({
  spec,
  coreIngressUrl,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  channelClient,
} = {}) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("spec must be an object");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const channelDeliveries = [];
  const metrics = {
    ingress_published_total: 0,
    ingress_failed_total: 0,
    egress_accepted_total: 0,
    egress_duplicate_total: 0,
    egress_rejected_total: 0,
  };
  const externalClient = channelClient ?? createNoopChannelClient();

  const capabilityDescriptor = createM2CapabilityDescriptor({
    spec,
    generatedAt: now(),
  });

  return {
    capabilityDescriptor,

    getMetrics() {
      return { ...metrics };
    },

    getChannelDeliveries() {
      return channelDeliveries.map((delivery) => structuredClone(delivery));
    },

    async emulateIncomingMessage(payload) {
      return this.publishIncomingMessage(payload);
    },

    async publishIncomingMessage(payload) {
      if (typeof coreIngressUrl !== "string" || coreIngressUrl.trim() === "") {
        throw new Error("coreIngressUrl is required to publish C2 Ingress");
      }

      const message = normalizeM2IncomingMessage({ spec, payload, now });
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

    async acceptEgressDelivery(delivery) {
      let channelDelivery;
      try {
        channelDelivery = normalizeM2OutgoingDelivery({ spec, delivery });
      } catch (error) {
        metrics.egress_rejected_total += 1;
        return {
          accepted: false,
          errors: [error.message],
        };
      }

      const duplicate = channelDeliveries.find(
        (item) => item.idempotency_key === channelDelivery.idempotency_key,
      );

      if (duplicate) {
        metrics.egress_duplicate_total += 1;
        return {
          accepted: true,
          duplicate: true,
          delivery: structuredClone(duplicate),
        };
      }

      const acceptedDelivery = {
        ...channelDelivery,
        accepted_at: now(),
      };

      if (typeof externalClient.deliver === "function") {
        await externalClient.deliver(acceptedDelivery);
      }
      channelDeliveries.push(acceptedDelivery);
      metrics.egress_accepted_total += 1;

      return {
        accepted: true,
        duplicate: false,
        delivery: structuredClone(acceptedDelivery),
      };
    },
  };
}

export function createM2CapabilityDescriptor({
  spec,
  channelId,
  generatedAt = new Date().toISOString(),
}) {
  const descriptor = createCapabilityDescriptor({
    channelType: spec.channelType,
    channelId,
    adapterName: spec.adapterName,
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        createCapability(spec, capability),
      ]),
    ),
    generatedAt,
  });

  const validation = validateCapabilityDescriptor(descriptor);
  if (!validation.valid) {
    throw new Error(
      `Invalid ${spec.channelType} C6 descriptor: ${validation.errors.join("; ")}`,
    );
  }

  return descriptor;
}

export function normalizeM2IncomingMessage({ spec, payload, now }) {
  const errors = [];
  expectRecord(errors, payload, "payload");

  const normalized = spec.normalizeIncomingPayload(payload);
  expectNonEmptyString(errors, normalized.organizationId, "organization_id");
  expectNonEmptyString(errors, normalized.channelId, "channel_id");
  expectNonEmptyString(errors, normalized.conversationRef, "conversation_ref");
  expectNonEmptyString(errors, normalized.senderRef, "sender_ref");

  if (normalized.text !== undefined && typeof normalized.text !== "string") {
    errors.push("text must be a string");
  }

  const attachments = normalizeAttachments(normalized.attachments ?? [], errors);
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

  const messageType = inferContentType(spec, normalized, attachments, errors);
  if (errors.length > 0) {
    throw new TypeError(errors.join("; "));
  }

  const messageId =
    normalized.messageId ?? normalized.idempotencyKey ?? `${spec.channelType}-in-${randomUUID()}`;
  const occurredAt = normalized.occurredAt ?? now();
  const content = {
    type: messageType,
    ...(normalized.text !== undefined && normalized.text !== ""
      ? { text: normalized.text }
      : {}),
  };

  return {
    message_id: messageId,
    idempotency_key: messageId,
    organization_id: normalized.organizationId,
    channel_id: normalized.channelId,
    channel_type: spec.channelType,
    external_message_id: normalized.externalMessageId ?? messageId,
    conversation_ref: normalized.conversationRef,
    sender_ref: normalized.senderRef,
    direction: "inbound",
    content,
    attachments,
    occurred_at: occurredAt,
    ...(normalized.identity ? { identity: normalized.identity } : {}),
  };
}

export function normalizeM2OutgoingDelivery({ spec, delivery }) {
  const errors = validateEgressDelivery(spec, delivery);
  const attachments = normalizeAttachments(delivery?.message?.attachments ?? [], errors);
  if (errors.length > 0) {
    throw new TypeError(errors.join("; "));
  }

  const message = delivery.message;
  const recipientRef = message.recipient_ref ?? message.conversation_ref;
  const channelDelivery = {
    idempotency_key: delivery.idempotency_key,
    message_id: message.message_id,
    organization_id: message.organization_id,
    channel_id: delivery.channel_id,
    channel_type: spec.channelType,
    conversation_ref: message.conversation_ref,
    recipient_ref: recipientRef,
    type: message.content.type,
    text: message.content.text,
    attachments,
  };

  return {
    ...channelDelivery,
    external_payload: spec.createExternalPayload(channelDelivery, message),
  };
}

export function isM2EgressDeliveryForSpec(delivery, spec) {
  return (
    delivery?.message?.channel_type === spec.channelType ||
    delivery?.message?.channel === spec.channelType
  );
}

export function getNestedValue(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function attachmentKindFromMime(mime, fallback = "file") {
  if (typeof mime !== "string") {
    return fallback;
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "voice";
  }
  return fallback;
}

export function normalizeExternalAttachment({
  id,
  kind,
  storageRef,
  mime,
  filename,
  size,
}) {
  return {
    id,
    kind,
    storage_ref: storageRef,
    mime,
    ...(filename !== undefined ? { filename } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function createNoopChannelClient() {
  return {
    async deliver() {},
  };
}

function createCapability(spec, capability) {
  const capabilityConfig = spec.capabilities?.[capability];
  if (capabilityConfig) {
    return { ...capabilityConfig };
  }

  if (spec.supportedCapabilities.has(capability)) {
    return { supported: true };
  }

  return {
    supported: false,
    notes: `Not supported by the M2 ${spec.channelType} adapter.`,
  };
}

function inferContentType(spec, payload, attachments, errors) {
  const supportedMessageTypes = spec.supportedMessageTypes;
  if (payload.type !== undefined) {
    if (!supportedMessageTypes.has(payload.type)) {
      errors.push(
        `type must be one of: ${Array.from(supportedMessageTypes).join(", ")}`,
      );
    }
    return payload.type;
  }

  if (payload.text !== undefined && payload.text !== "") {
    return "text";
  }

  const attachmentKind = attachments[0]?.kind ?? "text";
  if (!supportedMessageTypes.has(attachmentKind)) {
    errors.push(
      `attachment kind ${JSON.stringify(attachmentKind)} is not supported by ${spec.channelType}`,
    );
  }
  return attachmentKind;
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

    if (!ATTACHMENT_KINDS.has(attachment?.kind)) {
      errors.push(
        `attachments[${index}].kind must be one of: ${Array.from(ATTACHMENT_KINDS).join(", ")}`,
      );
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

function validateEgressDelivery(spec, delivery) {
  const errors = [];

  expectRecord(errors, delivery, "delivery");
  expectEqual(errors, delivery?.contract, "C2.EgressDelivery", "contract");
  expectEqual(errors, delivery?.version, C2_VERSION, "version");
  expectNonEmptyString(errors, delivery?.idempotency_key, "idempotency_key");
  expectNonEmptyString(errors, delivery?.channel_id, "channel_id");
  expectRecord(errors, delivery?.message, "message");
  expectNonEmptyString(errors, delivery?.message?.message_id, "message.message_id");
  expectNonEmptyString(
    errors,
    delivery?.message?.organization_id,
    "message.organization_id",
  );
  expectNonEmptyString(errors, delivery?.message?.channel_id, "message.channel_id");
  expectEqual(errors, delivery?.message?.direction, "outbound", "message.direction");
  expectRecord(errors, delivery?.message?.content, "message.content");
  expectNonEmptyString(errors, delivery?.message?.content?.type, "message.content.type");
  expectNonEmptyString(errors, delivery?.message?.conversation_ref, "message.conversation_ref");

  if (
    typeof delivery?.channel_id === "string" &&
    typeof delivery?.message?.channel_id === "string" &&
    delivery.channel_id !== delivery.message.channel_id
  ) {
    errors.push("channel_id must match message.channel_id");
  }

  if (
    typeof delivery?.idempotency_key === "string" &&
    typeof delivery?.message?.message_id === "string" &&
    delivery.idempotency_key !== delivery.message.message_id
  ) {
    errors.push("idempotency_key must match message.message_id");
  }

  if (
    delivery?.message?.channel_type !== undefined &&
    delivery.message.channel_type !== spec.channelType
  ) {
    errors.push(`message.channel_type must equal ${JSON.stringify(spec.channelType)}`);
  }

  if (
    typeof delivery?.message?.content?.type === "string" &&
    !spec.supportedMessageTypes.has(delivery.message.content.type)
  ) {
    errors.push(
      `message.content.type must be one of: ${Array.from(spec.supportedMessageTypes).join(", ")}`,
    );
  }

  return errors;
}

function expectRecord(errors, value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
  }
}

function expectEqual(errors, actual, expected, path) {
  if (actual !== expected) {
    errors.push(`${path} must equal ${JSON.stringify(expected)}`);
  }
}

function expectNonEmptyString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}
