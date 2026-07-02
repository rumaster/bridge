import { readFileSync } from "node:fs";

import { validateCanonicalMessage } from "../message-model/index.mjs";
import { validateJsonSchema } from "./c4.mjs";

export const C9_CONTRACT = "C9.EdgeTunnelMessage";
export const C9_ACK_CONTRACT = "C9.EdgeTunnelAck";
export const C9_VERSION = "1.0.0";

export const C9_EDGE_TUNNEL_MESSAGE_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c9-edge-tunnel-message.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const C9_EDGE_TUNNEL_ACK_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c9-edge-tunnel-ack.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function createEdgeTunnelMessage({
  payload,
  receivedAt,
  bufferedAt = receivedAt,
  forwardedAt = new Date().toISOString(),
}) {
  return {
    contract: C9_CONTRACT,
    version: C9_VERSION,
    endpoint_id: payload?.endpoint_id,
    sequence_number: payload?.sequence_number,
    idempotency_key: payload?.idempotency_key,
    payload,
    timestamps: {
      received_at: receivedAt,
      buffered_at: bufferedAt,
      forwarded_at: forwardedAt,
    },
  };
}

export function createEdgeTunnelAck({
  accepted = true,
  duplicate = false,
  messageId,
  endpointId,
  sequenceNumber,
  idempotencyKey,
  coreStatus = "received",
  receivedAt = new Date().toISOString(),
}) {
  return {
    contract: C9_ACK_CONTRACT,
    version: C9_VERSION,
    accepted,
    duplicate,
    ...(messageId ? { message_id: messageId } : {}),
    endpoint_id: endpointId,
    sequence_number: sequenceNumber,
    idempotency_key: idempotencyKey,
    core_status: coreStatus,
    received_at: receivedAt,
  };
}

export function validateEdgeTunnelMessage(message) {
  const schemaValidation = validateJsonSchema(message, C9_EDGE_TUNNEL_MESSAGE_SCHEMA);
  const errors = [...schemaValidation.errors];

  if (!isRecord(message)) {
    return {
      valid: false,
      errors,
    };
  }

  const payloadValidation = validateCanonicalMessage(message.payload);
  errors.push(...payloadValidation.errors.map((error) => `payload.${error}`));

  if (isRecord(message.payload)) {
    if (message.payload.endpoint_id !== message.endpoint_id) {
      errors.push("payload.endpoint_id must match endpoint_id");
    }

    if (message.payload.sequence_number !== message.sequence_number) {
      errors.push("payload.sequence_number must match sequence_number");
    }

    if (message.payload.idempotency_key !== message.idempotency_key) {
      errors.push("payload.idempotency_key must match idempotency_key");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateEdgeTunnelAck(ack) {
  return validateJsonSchema(ack, C9_EDGE_TUNNEL_ACK_SCHEMA);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
