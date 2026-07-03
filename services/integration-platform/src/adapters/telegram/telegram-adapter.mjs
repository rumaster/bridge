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

export const TELEGRAM_CHANNEL_TYPE = "telegram";

const TELEGRAM_SPEC = {
  channelType: TELEGRAM_CHANNEL_TYPE,
  adapterName: "telegram-adapter",
  supportedCapabilities: new Set([
    "text",
    "image",
    "file",
    "voice",
    "video",
    "buttons",
    "typing_indicator",
    "delete",
    "edit",
  ]),
  supportedMessageTypes: new Set(["text", "image", "file", "voice", "video"]),
  capabilities: {
    buttons: {
      supported: true,
      constraints: { format: "inline_keyboard" },
    },
    read_receipt: {
      supported: false,
      notes: "Telegram Bot API does not expose reliable per-user read receipts to the adapter.",
    },
  },
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createTelegramAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: TELEGRAM_SPEC });
}

export function createTelegramCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: TELEGRAM_SPEC });
}

export function normalizeIncomingTelegramMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: TELEGRAM_SPEC, payload, now });
}

export function normalizeOutgoingTelegramDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: TELEGRAM_SPEC, delivery });
}

export function isTelegramEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, TELEGRAM_SPEC);
}

function normalizeIncomingPayload(payload) {
  const message = payload?.message ?? payload?.edited_message ?? payload?.channel_post ?? {};
  const chat = message.chat ?? {};
  const sender = message.from ?? message.sender_chat ?? {};
  const text = firstNonEmptyString(
    payload?.text,
    message.text,
    message.caption,
    payload?.body?.text,
  );
  const attachments = [
    ...normalizeTelegramPhotos(message.photo ?? []),
    normalizeTelegramMedia(message.document, "file", "application/octet-stream"),
    normalizeTelegramMedia(message.voice, "voice", "audio/ogg"),
    normalizeTelegramMedia(message.video, "video", "video/mp4"),
  ].filter(Boolean);
  const externalMessageId = firstNonEmptyString(
    payload?.external_message_id,
    message.message_id,
    payload?.update_id,
  );

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId,
    conversationRef: firstNonEmptyString(payload?.conversation_ref, chat.id),
    senderRef: firstNonEmptyString(payload?.sender_ref, sender.id, sender.username),
    text,
    attachments,
    occurredAt: normalizeUnixTimestamp(message.date) ?? payload?.occurred_at,
  };
}

function normalizeTelegramPhotos(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return [];
  }

  const photo = photos.at(-1);
  return [
    normalizeExternalAttachment({
      id: firstNonEmptyString(photo.file_unique_id, photo.file_id),
      kind: "image",
      storageRef: `telegram-file://${photo.file_id}`,
      mime: "image/jpeg",
      size: photo.file_size,
    }),
  ];
}

function normalizeTelegramMedia(media, fallbackKind, fallbackMime) {
  if (!media) {
    return null;
  }

  const mime = media.mime_type ?? fallbackMime;
  return normalizeExternalAttachment({
    id: firstNonEmptyString(media.file_unique_id, media.file_id),
    kind: fallbackKind ?? attachmentKindFromMime(mime),
    storageRef: `telegram-file://${media.file_id}`,
    mime,
    filename: media.file_name,
    size: media.file_size,
  });
}

function createExternalPayload(delivery) {
  const base = {
    idempotency_key: delivery.idempotency_key,
    chat_id: delivery.recipient_ref,
  };

  if (delivery.type === "text") {
    return {
      method: "sendMessage",
      ...base,
      text: delivery.text ?? "",
    };
  }

  const attachment = delivery.attachments[0];
  const methodByType = {
    image: "sendPhoto",
    file: "sendDocument",
    voice: "sendVoice",
    video: "sendVideo",
  };

  return {
    method: methodByType[delivery.type] ?? "sendMessage",
    ...base,
    caption: delivery.text,
    media: attachment?.storage_ref,
  };
}

function normalizeUnixTimestamp(value) {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}
