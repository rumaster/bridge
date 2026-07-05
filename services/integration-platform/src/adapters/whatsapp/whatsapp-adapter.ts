import {
  attachmentKindFromMime,
  createM2CapabilityDescriptor,
  createM2ChannelAdapter,
  firstNonEmptyString,
  getNestedValue,
  isM2EgressDeliveryForSpec,
  normalizeExternalAttachment,
  normalizeM2IncomingMessage,
  normalizeM2OutgoingDelivery,
} from "../common/m2-channel-adapter.js";

export const WHATSAPP_CHANNEL_TYPE = "whatsapp";

const WHATSAPP_SPEC = {
  channelType: WHATSAPP_CHANNEL_TYPE,
  adapterName: "whatsapp-adapter",
  supportedCapabilities: new Set([
    "text",
    "image",
    "file",
    "voice",
    "video",
    "buttons",
    "read_receipt",
  ]),
  supportedMessageTypes: new Set(["text", "image", "file", "voice", "video"]),
  capabilities: {
    buttons: {
      supported: true,
      constraints: { format: "interactive" },
    },
    read_receipt: {
      supported: true,
      constraints: { source: "message_status_webhook" },
    },
    typing_indicator: {
      supported: false,
      notes: "The M2 WhatsApp adapter does not expose typing indicators.",
    },
  },
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createWhatsAppAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: WHATSAPP_SPEC });
}

export function createWhatsAppCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: WHATSAPP_SPEC });
}

export function normalizeIncomingWhatsAppMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: WHATSAPP_SPEC, payload, now });
}

export function normalizeOutgoingWhatsAppDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: WHATSAPP_SPEC, delivery });
}

export function isWhatsAppEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, WHATSAPP_SPEC);
}

function normalizeIncomingPayload(payload) {
  const message =
    getNestedValue(payload, ["entry", 0, "changes", 0, "value", "messages", 0]) ??
    payload?.message ??
    payload ?? {};
  const from = firstNonEmptyString(message.from, payload?.sender_ref);
  const text = firstNonEmptyString(payload?.text, message.text?.body, message.button?.text);

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId: firstNonEmptyString(payload?.external_message_id, message.id),
    conversationRef: firstNonEmptyString(payload?.conversation_ref, from),
    senderRef: from,
    text,
    attachments: normalizeWhatsAppAttachments(message),
    occurredAt: normalizeUnixTimestamp(message.timestamp) ?? payload?.occurred_at,
    identity: from ? { type: "verified_phone", value: from } : undefined,
  };
}

function normalizeWhatsAppAttachments(message) {
  const candidates = [
    ["image", message.image],
    ["file", message.document],
    ["voice", message.audio],
    ["video", message.video],
  ];

  return candidates
    .filter(([, media]) => media)
    .map(([kind, media]) => {
      const mime = media.mime_type ?? mimeForWhatsAppKind(kind);
      const id = firstNonEmptyString(media.id, media.sha256, media.filename);
      return normalizeExternalAttachment({
        id,
        kind: kind === "file" ? attachmentKindFromMime(mime, "file") : kind,
        storageRef: `whatsapp-media://${id}`,
        mime,
        filename: media.filename,
        size: media.file_size,
      });
    });
}

function mimeForWhatsAppKind(kind) {
  if (kind === "image") {
    return "image/jpeg";
  }
  if (kind === "video") {
    return "video/mp4";
  }
  if (kind === "voice") {
    return "audio/ogg";
  }
  return "application/octet-stream";
}

function createExternalPayload(delivery) {
  if (delivery.type === "text") {
    return {
      messaging_product: "whatsapp",
      to: delivery.recipient_ref,
      type: "text",
      text: {
        body: delivery.text ?? "",
      },
      idempotency_key: delivery.idempotency_key,
    };
  }

  const attachment = delivery.attachments[0];
  const mediaType = delivery.type === "file" ? "document" : delivery.type;

  return {
    messaging_product: "whatsapp",
    to: delivery.recipient_ref,
    type: mediaType,
    [mediaType]: {
      id: attachment?.storage_ref,
      caption: delivery.text,
      filename: attachment?.filename,
    },
    idempotency_key: delivery.idempotency_key,
  };
}

function normalizeUnixTimestamp(value) {
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return new Date(Number(value) * 1000).toISOString();
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}
