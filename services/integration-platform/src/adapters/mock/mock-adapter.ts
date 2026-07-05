import { randomUUID } from "node:crypto";

import {
  C6_CAPABILITIES,
  createCapabilityDescriptor,
  validateCapabilityDescriptor,
} from "../../../../../packages/contracts/src/c6.js";

const C2_VERSION = "1.0.0";
const MOCK_CHANNEL_TYPE = "mock";

export function createMockAdapter({
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

  const capabilityDescriptor = createCapabilityDescriptor({
    channelType: MOCK_CHANNEL_TYPE,
    adapterName: "mock-adapter",
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        { supported: true },
      ]),
    ),
  });

  const validation = validateCapabilityDescriptor(capabilityDescriptor);
  if (!validation.valid) {
    throw new Error(`Invalid mock C6 descriptor: ${validation.errors.join("; ")}`);
  }

  return {
    capabilityDescriptor,

    getMetrics() {
      return { ...metrics };
    },

    getChannelDeliveries() {
      return channelDeliveries.map((delivery) => structuredClone(delivery));
    },

    async emulateIncomingMessage(payload) {
      if (typeof coreIngressUrl !== "string" || coreIngressUrl.trim() === "") {
        throw new Error("coreIngressUrl is required to publish C2 Ingress");
      }

      const message = createInboundMessage(payload, now);
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
      const errors = validateEgressDelivery(delivery);
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
        channel_id: delivery.channel_id,
        message_id: delivery.message.message_id,
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

function createInboundMessage(payload, now) {
  const errors = [];
  expectRecord(errors, payload, "payload");
  expectNonEmptyString(errors, payload?.organization_id, "organization_id");
  expectNonEmptyString(errors, payload?.channel_id, "channel_id");
  expectNonEmptyString(errors, payload?.conversation_ref, "conversation_ref");
  expectNonEmptyString(errors, payload?.sender_ref, "sender_ref");
  expectNonEmptyString(errors, payload?.text, "text");

  if (errors.length > 0) {
    throw new TypeError(errors.join("; "));
  }

  const occurredAt = payload.occurred_at ?? now();

  return {
    message_id: payload.message_id ?? `mock-in-${randomUUID()}`,
    organization_id: payload.organization_id,
    channel_id: payload.channel_id,
    channel_type: MOCK_CHANNEL_TYPE,
    external_message_id: payload.external_message_id ?? payload.message_id,
    conversation_ref: payload.conversation_ref,
    sender_ref: payload.sender_ref,
    direction: "inbound",
    content: {
      type: "text",
      text: payload.text,
    },
    attachments: payload.attachments ?? [],
    occurred_at: occurredAt,
  };
}

function validateEgressDelivery(delivery) {
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

  if (
    typeof delivery?.channel_id === "string" &&
    typeof delivery?.message?.channel_id === "string" &&
    delivery.channel_id !== delivery.message.channel_id
  ) {
    errors.push("channel_id must match message.channel_id");
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
