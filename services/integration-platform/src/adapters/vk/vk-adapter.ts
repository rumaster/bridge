import {
  attachmentKindFromMime,
  createM2CapabilityDescriptor,
  createM2ChannelAdapter,
  firstNonEmptyString,
  isM2EgressDeliveryForSpec,
  normalizeExternalAttachment,
  normalizeM2IncomingMessage,
  normalizeM2OutgoingDelivery,
} from "../common/m2-channel-adapter.js";

export const VK_CHANNEL_TYPE = "vk";

const VK_SPEC = {
  channelType: VK_CHANNEL_TYPE,
  adapterName: "vk-adapter",
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
      constraints: { format: "keyboard" },
    },
    read_receipt: {
      supported: false,
      notes: "The M2 VK adapter does not publish reliable read receipts to C6.",
    },
  },
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createVkAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: VK_SPEC });
}

export function createVkCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: VK_SPEC });
}

export function normalizeIncomingVkMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: VK_SPEC, payload, now });
}

export function normalizeOutgoingVkDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: VK_SPEC, delivery });
}

export function isVkEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, VK_SPEC);
}

function normalizeIncomingPayload(payload) {
  const message = payload?.object?.message ?? payload?.message ?? payload ?? {};
  const peerId = firstNonEmptyString(message.peer_id, payload?.conversation_ref);
  const senderId = firstNonEmptyString(message.from_id, payload?.sender_ref);

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId: firstNonEmptyString(payload?.external_message_id, message.id),
    conversationRef: peerId,
    senderRef: senderId,
    text: firstNonEmptyString(payload?.text, message.text),
    attachments: normalizeVkAttachments(message.attachments ?? payload?.attachments ?? []),
    occurredAt: normalizeUnixTimestamp(message.date) ?? payload?.occurred_at,
  };
}

function normalizeVkAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return attachments;
  }

  return attachments.map((attachment) => {
    const type = attachment.type;
    const media = attachment[type] ?? attachment;
    const mime = media.mime_type ?? mimeForVkType(type);
    const id = firstNonEmptyString(media.id, `${media.owner_id}_${media.id}`, attachment.id);
    return normalizeExternalAttachment({
      id,
      kind: kindForVkType(type, mime),
      storageRef: storageRefForVkAttachment(type, media, id),
      mime,
      filename: media.title ?? media.filename,
      size: media.size,
    });
  });
}

function kindForVkType(type, mime) {
  if (type === "photo") {
    return "image";
  }
  if (type === "video") {
    return "video";
  }
  if (type === "audio_message") {
    return "voice";
  }
  return attachmentKindFromMime(mime);
}

function mimeForVkType(type) {
  if (type === "photo") {
    return "image/jpeg";
  }
  if (type === "video") {
    return "video/mp4";
  }
  if (type === "audio_message") {
    return "audio/ogg";
  }
  return "application/octet-stream";
}

function storageRefForVkAttachment(type, media, id) {
  if (type === "photo" && Array.isArray(media.sizes) && media.sizes.length > 0) {
    return media.sizes.at(-1).url;
  }
  if (media.link_ogg) {
    return media.link_ogg;
  }
  if (media.url) {
    return media.url;
  }
  return `vk-attachment://${id}`;
}

function createExternalPayload(delivery) {
  return {
    method: "messages.send",
    idempotency_key: delivery.idempotency_key,
    random_id: delivery.idempotency_key,
    peer_id: delivery.recipient_ref,
    message: delivery.text ?? "",
    attachments: delivery.attachments.map((attachment) => attachment.storage_ref),
  };
}

function normalizeUnixTimestamp(value) {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}
