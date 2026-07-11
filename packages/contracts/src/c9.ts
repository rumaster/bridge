import { readFileSync } from "node:fs";

import { validateCanonicalMessage } from "../message-model/index.js";
import { validateJsonSchema } from "./c4.js";

export const C9_CONTRACT = "C9.EdgeTunnelMessage";
export const C9_ACK_CONTRACT = "C9.EdgeTunnelAck";
export const C9_CONTROL_CONTRACT = "C9.EdgeControlMessage";
export const C9_CONTROL_ACK_CONTRACT = "C9.EdgeControlAck";
export const C9_VERSION = "1.0.0";

/** Направления App→Edge control-plane (Этап E2 плана email-channel-production). */
export const C9_CONTROL_TYPES = Object.freeze([
  "channel_credentials_sync",
  "egress_dispatch",
] as const);
export type C9ControlType = (typeof C9_CONTROL_TYPES)[number];

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

export const C9_EDGE_CONTROL_MESSAGE_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c9-edge-control-message.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const C9_EDGE_CONTROL_ACK_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c9-edge-control-ack.schema.json", import.meta.url),
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

  // C9-туннель несёт либо канонический C1, либо конверт C2.IngressMessage: входящее из
  // SVC-INT (у него нет БД для резолва endpoint/conversation — их назначает ядро в
  // acceptIngress). Для C2-конверта глубокую канон-валидацию пропускаем — он
  // валидируется на приёме ядром (normalizeIngressEnvelope), а транспорт лишь не
  // должен его отвергать.
  const isC2Ingress =
    isRecord(message.payload) &&
    message.payload.contract === "C2.IngressMessage" &&
    isRecord(message.payload.message);
  if (!isC2Ingress) {
    const payloadValidation = validateCanonicalMessage(message.payload);
    errors.push(...payloadValidation.errors.map((error) => `payload.${error}`));
  }

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

/**
 * App→Edge control-сообщение (Этап E2). Несёт по защищённому туннелю
 * управляющие операции, которых нет в data-plane (Edge→App):
 *   - `channel_credentials_sync` — доставка структурных кред email-канала на Edge
 *     (payload: `{ channel_id, channel_type, credentials }`);
 *   - `egress_dispatch` — задание Edge отправить исходящее (payload несёт
 *     `message_id` и данные доставки).
 * `control_id` — сквозной ключ идемпотентности: повтор после переподключения
 * дедуплицируется Edge по нему.
 */
export function createEdgeControlMessage({
  type,
  organizationId,
  controlId,
  payload,
  issuedAt = new Date().toISOString(),
}) {
  return {
    contract: C9_CONTROL_CONTRACT,
    version: C9_VERSION,
    control_id: controlId,
    type,
    organization_id: organizationId,
    payload,
    issued_at: issuedAt,
  };
}

export function createEdgeControlAck({
  controlId,
  accepted = true,
  duplicate = false,
  status,
  detail = undefined,
  externalMessageId = undefined,
  receivedAt = new Date().toISOString(),
}) {
  return {
    contract: C9_CONTROL_ACK_CONTRACT,
    version: C9_VERSION,
    control_id: controlId,
    accepted,
    duplicate,
    status,
    ...(detail ? { detail } : {}),
    ...(externalMessageId ? { external_message_id: externalMessageId } : {}),
    received_at: receivedAt,
  };
}

export function validateEdgeControlMessage(message) {
  const schemaValidation = validateJsonSchema(message, C9_EDGE_CONTROL_MESSAGE_SCHEMA);
  const errors = [...schemaValidation.errors];

  if (!isRecord(message) || !isRecord(message.payload)) {
    return { valid: errors.length === 0, errors };
  }

  const payload = message.payload;
  if (message.type === "channel_credentials_sync") {
    if (typeof payload.channel_type !== "string" || payload.channel_type.trim() === "") {
      errors.push("payload.channel_type is required for channel_credentials_sync");
    }
    if (!isRecord(payload.credentials)) {
      errors.push("payload.credentials must be an object for channel_credentials_sync");
    }
  } else if (message.type === "egress_dispatch") {
    if (typeof payload.message_id !== "string" || payload.message_id.trim() === "") {
      errors.push("payload.message_id is required for egress_dispatch");
    }
    if (typeof payload.channel_type !== "string" || payload.channel_type.trim() === "") {
      errors.push("payload.channel_type is required for egress_dispatch");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateEdgeControlAck(ack) {
  return validateJsonSchema(ack, C9_EDGE_CONTROL_ACK_SCHEMA);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
