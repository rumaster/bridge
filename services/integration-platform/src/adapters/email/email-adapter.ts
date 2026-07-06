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

export const EMAIL_CHANNEL_TYPE = "email";

const EMAIL_SPEC = {
  channelType: EMAIL_CHANNEL_TYPE,
  adapterName: "email-adapter",
  supportedCapabilities: new Set(["text", "image", "file"]),
  supportedMessageTypes: new Set(["text", "image", "file"]),
  capabilities: {
    image: {
      supported: true,
      constraints: { transport: "attachment" },
    },
    file: {
      supported: true,
      constraints: { transport: "attachment" },
    },
    read_receipt: {
      supported: false,
      notes: "Email read receipts are optional and not reliable enough for C6 read_receipt.",
    },
  },
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createEmailAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: EMAIL_SPEC });
}

export function createEmailCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: EMAIL_SPEC });
}

export function normalizeIncomingEmailMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: EMAIL_SPEC, payload, now });
}

export function normalizeOutgoingEmailDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: EMAIL_SPEC, delivery });
}

export function isEmailEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, EMAIL_SPEC);
}

function normalizeIncomingPayload(payload) {
  const email = payload?.email ?? payload?.message ?? payload ?? {};
  const from = firstNonEmptyString(email.from, email.sender, payload?.sender_ref);
  const text = firstNonEmptyString(
    payload?.text,
    email.text,
    email.text_body,
    email.body?.text,
    email.subject,
  );

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId: firstNonEmptyString(
      payload?.external_message_id,
      email.message_id,
      email.id,
    ),
    conversationRef: firstNonEmptyString(payload?.conversation_ref, email.thread_id, from),
    senderRef: from,
    text,
    attachments: normalizeEmailAttachments(email.attachments ?? payload?.attachments ?? []),
    occurredAt: email.date ?? payload?.occurred_at,
    identity: from ? { type: "verified_email", value: from } : undefined,
  };
}

function normalizeEmailAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return attachments;
  }

  return attachments.map((attachment) => {
    const mime = attachment.mime ?? attachment.mime_type ?? "application/octet-stream";
    const id = firstNonEmptyString(
      attachment.id,
      attachment.content_id,
      attachment.filename,
      attachment.storage_ref,
    );
    return normalizeExternalAttachment({
      id,
      kind: attachment.kind ?? attachmentKindFromMime(mime),
      storageRef: attachment.storage_ref ?? `email-attachment://${id}`,
      mime,
      filename: attachment.filename,
      size: attachment.size,
    });
  });
}

function createExternalPayload(delivery, message) {
  return {
    idempotency_key: delivery.idempotency_key,
    to: delivery.recipient_ref,
    subject: message.content.subject ?? "Ответ",
    text: delivery.text ?? "",
    attachments: delivery.attachments.map((attachment) => ({
      storage_ref: attachment.storage_ref,
      filename: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
    })),
  };
}
