import {
  attachmentKindFromMime,
  createM2CapabilityDescriptor,
  createM2ChannelAdapter,
  firstNonEmptyString,
  isM2EgressDeliveryForSpec,
  normalizeExternalAttachment,
  normalizeM2IncomingMessage,
  normalizeM2OutgoingDelivery,
} from "../common/m2-channel-adapter.mjs";

export const MAX_CHANNEL_TYPE = "max";

const MAX_SPEC = {
  channelType: MAX_CHANNEL_TYPE,
  adapterName: "max-adapter",
  supportedCapabilities: new Set([
    "text",
    "image",
    "file",
    "voice",
    "video",
    "buttons",
    "typing_indicator",
  ]),
  supportedMessageTypes: new Set(["text", "image", "file", "voice", "video"]),
  capabilities: {
    buttons: {
      supported: true,
      constraints: { format: "inline_buttons" },
    },
    read_receipt: {
      supported: false,
      notes: "The M2 MAX adapter does not publish read receipt events.",
    },
  },
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createMaxAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: MAX_SPEC });
}

export function createMaxCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: MAX_SPEC });
}

export function normalizeIncomingMaxMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: MAX_SPEC, payload, now });
}

export function normalizeOutgoingMaxDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: MAX_SPEC, delivery });
}

export function isMaxEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, MAX_SPEC);
}

function normalizeIncomingPayload(payload) {
  const message = payload?.message ?? payload ?? {};
  const sender = message.sender ?? message.from ?? {};
  const body = message.body ?? {};

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId: firstNonEmptyString(payload?.external_message_id, message.id),
    conversationRef: firstNonEmptyString(payload?.conversation_ref, message.chat_id, message.dialog_id),
    senderRef: firstNonEmptyString(payload?.sender_ref, sender.user_id, sender.id),
    text: firstNonEmptyString(payload?.text, body.text, message.text),
    attachments: normalizeMaxAttachments(message.attachments ?? payload?.attachments ?? []),
    occurredAt: message.created_at ?? payload?.occurred_at,
  };
}

function normalizeMaxAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return attachments;
  }

  return attachments.map((attachment) => {
    const mime = attachment.mime_type ?? attachment.mime ?? mimeForMaxType(attachment.type);
    const id = firstNonEmptyString(attachment.id, attachment.url, attachment.storage_ref);
    return normalizeExternalAttachment({
      id,
      kind: kindForMaxType(attachment.type, mime),
      storageRef: attachment.storage_ref ?? attachment.url ?? `max-attachment://${id}`,
      mime,
      filename: attachment.filename,
      size: attachment.size,
    });
  });
}

function kindForMaxType(type, mime) {
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

function mimeForMaxType(type) {
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

function createExternalPayload(delivery) {
  return {
    idempotency_key: delivery.idempotency_key,
    chat_id: delivery.recipient_ref,
    text: delivery.text ?? "",
    attachments: delivery.attachments.map((attachment) => ({
      type: attachment.kind,
      storage_ref: attachment.storage_ref,
      mime: attachment.mime,
      filename: attachment.filename,
    })),
  };
}
