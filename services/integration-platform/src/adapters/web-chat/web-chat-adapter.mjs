import {
  C6_CAPABILITIES,
  createCapabilityDescriptor,
  validateCapabilityDescriptor,
} from "../../../../../packages/contracts/src/c6.mjs";
import {
  MESSAGE_CHANNEL,
  MESSAGE_DIRECTION,
  MESSAGE_SENDER_TYPE,
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  validateCanonicalMessage,
} from "../../../../../packages/contracts/message-model/index.mjs";

const WEB_CHAT_ADAPTER_NAME = "web-chat-adapter";

export class WebChatAdapterValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.name = "WebChatAdapterValidationError";
    this.errors = errors;
  }
}

export function createWebChatAdapter({
  coreIngressUrl,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
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
  const capabilityDescriptor = createWebChatCapabilityDescriptor({ now });

  return {
    capabilityDescriptor,

    getMetrics() {
      return { ...metrics };
    },

    getChannelDeliveries() {
      return channelDeliveries.map((delivery) => structuredClone(delivery));
    },

    async publishIncomingMessage(payload) {
      if (typeof coreIngressUrl !== "string" || coreIngressUrl.trim() === "") {
        throw new Error("coreIngressUrl is required to publish Web Chat C2 Ingress");
      }

      const message = normalizeIncomingWebChatMessage(payload, { now });
      const response = await fetchImpl(coreIngressUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        metrics.ingress_failed_total += 1;
        throw new Error(`Web Chat C2 Ingress rejected with HTTP ${response.status}`);
      }

      metrics.ingress_published_total += 1;

      return {
        accepted: true,
        core_status: response.status,
        message_id: message.id,
        idempotency_key: message.idempotency_key,
        conversation_id: message.conversation_id,
        endpoint_id: message.endpoint_id,
        ingress: message,
      };
    },

    acceptEgressDelivery(delivery) {
      const errors = validateWebChatEgressDelivery(delivery);
      if (errors.length > 0) {
        metrics.egress_rejected_total += 1;
        return {
          accepted: false,
          errors,
        };
      }

      const duplicate = channelDeliveries.find(
        (item) => item.idempotency_key === delivery.idempotency_key,
      );

      if (duplicate) {
        metrics.egress_duplicate_total += 1;
        return {
          accepted: true,
          duplicate: true,
          delivery: structuredClone(duplicate),
        };
      }

      const channelDelivery = {
        idempotency_key: delivery.idempotency_key,
        message_id: delivery.message.message_id,
        organization_id: delivery.message.organization_id,
        conversation_ref: delivery.message.conversation_ref,
        channel_id: delivery.channel_id,
        content: delivery.message.content,
        accepted_at: now(),
      };

      channelDeliveries.push(channelDelivery);
      metrics.egress_accepted_total += 1;

      return {
        accepted: true,
        duplicate: false,
        delivery: structuredClone(channelDelivery),
      };
    },
  };
}

export function normalizeIncomingWebChatMessage(payload, { now = () => new Date().toISOString() } = {}) {
  const errors = validateIncomingPayload(payload);
  if (errors.length > 0) {
    throw new WebChatAdapterValidationError(errors);
  }

  const occurredAt = payload.occurred_at ?? now();
  const message = {
    id: payload.idempotency_key,
    idempotency_key: payload.idempotency_key,
    organization_id: payload.organization_id,
    conversation_id: payload.conversation_id,
    endpoint_id: payload.endpoint_id,
    channel: MESSAGE_CHANNEL.WEB_CHAT,
    direction: MESSAGE_DIRECTION.INBOUND,
    sender_type: MESSAGE_SENDER_TYPE.CLIENT,
    sequence_number: payload.sequence_number ?? 1,
    type: MESSAGE_TYPE.TEXT,
    content: {
      text: payload.text,
    },
    status: MESSAGE_STATUS.RECEIVED,
    created_at: occurredAt,
    updated_at: occurredAt,
    metadata: {
      visitor_session_id: payload.visitor_session_id,
    },
  };

  const validation = validateCanonicalMessage(message);
  if (!validation.valid) {
    throw new WebChatAdapterValidationError(validation.errors);
  }

  return message;
}

function createWebChatCapabilityDescriptor({ now }) {
  const supported = new Set([
    "text",
    "image",
    "file",
    "typing_indicator",
    "read_receipt",
  ]);
  const descriptor = createCapabilityDescriptor({
    channelType: MESSAGE_CHANNEL.WEB_CHAT,
    adapterName: WEB_CHAT_ADAPTER_NAME,
    adapterVersion: "0.1.0",
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        { supported: supported.has(capability) },
      ]),
    ),
    generatedAt: now(),
  });
  const validation = validateCapabilityDescriptor(descriptor);

  if (!validation.valid) {
    throw new Error(`Invalid Web Chat C6 descriptor: ${validation.errors.join("; ")}`);
  }

  return descriptor;
}

function validateIncomingPayload(payload) {
  const errors = [];

  expectRecord(errors, payload, "payload");
  expectNonEmptyString(errors, payload?.idempotency_key, "idempotency_key");
  expectNonEmptyString(errors, payload?.organization_id, "organization_id");
  expectNonEmptyString(errors, payload?.conversation_id, "conversation_id");
  expectNonEmptyString(errors, payload?.endpoint_id, "endpoint_id");
  expectNonEmptyString(errors, payload?.visitor_session_id, "visitor_session_id");
  expectNonEmptyString(errors, payload?.text, "text");

  if (
    payload?.sequence_number !== undefined &&
    (!Number.isSafeInteger(payload.sequence_number) || payload.sequence_number < 1)
  ) {
    errors.push("sequence_number must be a positive integer");
  }

  return errors;
}

function validateWebChatEgressDelivery(delivery) {
  const errors = [];

  expectRecord(errors, delivery, "delivery");
  expectEqual(errors, delivery?.contract, "C2.EgressDelivery", "contract");
  expectEqual(errors, delivery?.version, "1.0.0", "version");
  expectNonEmptyString(errors, delivery?.idempotency_key, "idempotency_key");
  expectNonEmptyString(errors, delivery?.channel_id, "channel_id");
  expectRecord(errors, delivery?.message, "message");
  expectNonEmptyString(errors, delivery?.message?.message_id, "message.message_id");
  expectNonEmptyString(errors, delivery?.message?.organization_id, "message.organization_id");
  expectEqual(errors, delivery?.message?.channel_type, MESSAGE_CHANNEL.WEB_CHAT, "message.channel_type");
  expectEqual(errors, delivery?.message?.direction, MESSAGE_DIRECTION.OUTBOUND, "message.direction");
  expectRecord(errors, delivery?.message?.content, "message.content");
  expectNonEmptyString(errors, delivery?.message?.content?.type, "message.content.type");

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
