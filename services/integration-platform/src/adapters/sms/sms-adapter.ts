import {
  createM2CapabilityDescriptor,
  createM2ChannelAdapter,
  firstNonEmptyString,
  isM2EgressDeliveryForSpec,
  normalizeM2IncomingMessage,
  normalizeM2OutgoingDelivery,
} from "../common/m2-channel-adapter.js";

export const SMS_CHANNEL_TYPE = "sms";

const SMS_SPEC = {
  channelType: SMS_CHANNEL_TYPE,
  adapterName: "sms-adapter",
  supportedCapabilities: new Set(["text"]),
  supportedMessageTypes: new Set(["text"]),
  normalizeIncomingPayload,
  createExternalPayload,
};

export function createSmsAdapter(options = {}) {
  return createM2ChannelAdapter({ ...options, spec: SMS_SPEC });
}

export function createSmsCapabilityDescriptor(options = {}) {
  return createM2CapabilityDescriptor({ ...options, spec: SMS_SPEC });
}

export function normalizeIncomingSmsMessage(payload, now = () => new Date().toISOString()) {
  return normalizeM2IncomingMessage({ spec: SMS_SPEC, payload, now });
}

export function normalizeOutgoingSmsDelivery(delivery) {
  return normalizeM2OutgoingDelivery({ spec: SMS_SPEC, delivery });
}

export function isSmsEgressDelivery(delivery) {
  return isM2EgressDeliveryForSpec(delivery, SMS_SPEC);
}

function normalizeIncomingPayload(payload) {
  const sms = payload?.sms ?? payload?.message ?? payload ?? {};
  const from = firstNonEmptyString(sms.from, sms.msisdn, payload?.sender_ref);

  return {
    organizationId: payload?.organization_id,
    channelId: payload?.channel_id,
    messageId: payload?.message_id,
    idempotencyKey: payload?.idempotency_key,
    externalMessageId: firstNonEmptyString(payload?.external_message_id, sms.id, sms.message_id),
    conversationRef: firstNonEmptyString(payload?.conversation_ref, from),
    senderRef: from,
    text: firstNonEmptyString(payload?.text, sms.text, sms.body),
    attachments: [],
    occurredAt: sms.received_at ?? payload?.occurred_at,
    identity: from ? { type: "verified_phone", value: from } : undefined,
  };
}

function createExternalPayload(delivery) {
  return {
    idempotency_key: delivery.idempotency_key,
    to: delivery.recipient_ref,
    text: delivery.text ?? "",
  };
}
