import { BadRequestException } from "@nestjs/common";

import {
  C2_VERSION,
  type CanonicalIngressMessage,
  isUuid,
  normalizeChannel,
  normalizeIngressEnvelope,
  normalizeMessageType,
} from "./internal-messaging.dto";
import { MESSAGE_DIRECTION, MESSAGE_SENDER_TYPE, MESSAGE_STATUS } from "./message-status";

export const C8_BROADCAST_DELIVERY_CONTRACT = "C8.BroadcastCoreDeliveryDraft";
export const C9_EDGE_TUNNEL_MESSAGE_CONTRACT = "C9.EdgeTunnelMessage";
export const C9_EDGE_TUNNEL_ACK_CONTRACT = "C9.EdgeTunnelAck";

export interface EdgeTunnelMessage {
  contract?: unknown;
  version?: unknown;
  endpoint_id?: unknown;
  sequence_number?: unknown;
  idempotency_key?: unknown;
  payload?: CanonicalIngressMessage;
  timestamps?: unknown;
  [key: string]: unknown;
}

export interface EdgeTunnelAck {
  contract: typeof C9_EDGE_TUNNEL_ACK_CONTRACT;
  version: typeof C2_VERSION;
  accepted: boolean;
  duplicate: boolean;
  message_id?: string;
  endpoint_id: string;
  sequence_number: number;
  idempotency_key: string;
  core_status: string;
  received_at: string;
}

export interface BroadcastDeliveryDraft {
  contract?: unknown;
  version?: unknown;
  broadcast_id?: unknown;
  organization_id?: unknown;
  delivery_path?: unknown;
  core_contracts?: unknown;
  sender_type?: unknown;
  broadcast_name?: unknown;
  message?: {
    id?: unknown;
    idempotency_key?: unknown;
    organization_id?: unknown;
    conversation_id?: unknown;
    endpoint_id?: unknown;
    channel?: unknown;
    direction?: unknown;
    sender_type?: unknown;
    sequence_number?: unknown;
    type?: unknown;
    content?: unknown;
    status?: unknown;
    created_at?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NormalizedBroadcastDeliveryDraft {
  organizationId: string;
  broadcastId: string;
  broadcastName: string | null;
  message: {
    id: string;
    organization_id: string;
    conversation_id: string;
    endpoint_id: string;
    channel: string;
    type: string;
    content: Record<string, unknown>;
    created_at: string;
  };
}

export function normalizeEdgeTunnelMessage(
  tunnelMessage: EdgeTunnelMessage,
  now: () => string,
): EdgeTunnelMessage & {
  endpoint_id: string;
  sequence_number: number;
  idempotency_key: string;
  payload: CanonicalIngressMessage;
} {
  const errors: string[] = [];
  if (tunnelMessage.contract !== C9_EDGE_TUNNEL_MESSAGE_CONTRACT) {
    errors.push(`contract must equal ${JSON.stringify(C9_EDGE_TUNNEL_MESSAGE_CONTRACT)}`);
  }
  if (tunnelMessage.version !== C2_VERSION) {
    errors.push(`version must equal ${JSON.stringify(C2_VERSION)}`);
  }
  if (!isUuid(tunnelMessage.endpoint_id)) {
    errors.push("endpoint_id must be a UUID string");
  }
  if (
    !Number.isSafeInteger(tunnelMessage.sequence_number) ||
    (tunnelMessage.sequence_number as number) < 1
  ) {
    errors.push("sequence_number must be a positive integer");
  }
  if (!isUuid(tunnelMessage.idempotency_key)) {
    errors.push("idempotency_key must be a UUID string");
  }
  if (!isPlainObject(tunnelMessage.payload)) {
    errors.push("payload must be an object");
  }

  const payload = isPlainObject(tunnelMessage.payload) ? tunnelMessage.payload : {};
  if (payload.endpoint_id !== tunnelMessage.endpoint_id) {
    errors.push("payload.endpoint_id must match endpoint_id");
  }
  if (payload.sequence_number !== tunnelMessage.sequence_number) {
    errors.push("payload.sequence_number must match sequence_number");
  }
  if (payload.idempotency_key !== tunnelMessage.idempotency_key) {
    errors.push("payload.idempotency_key must match idempotency_key");
  }

  if (errors.length > 0) {
    throw m4BadRequest(`Invalid C9 edge tunnel message: ${errors.join("; ")}`);
  }

  normalizeIngressEnvelope(payload as CanonicalIngressMessage, now);

  return {
    ...tunnelMessage,
    endpoint_id: tunnelMessage.endpoint_id as string,
    sequence_number: tunnelMessage.sequence_number as number,
    idempotency_key: tunnelMessage.idempotency_key as string,
    payload: payload as CanonicalIngressMessage,
  };
}

export function createEdgeTunnelAck({
  accepted,
  duplicate,
  messageId,
  endpointId,
  sequenceNumber,
  idempotencyKey,
  coreStatus,
  receivedAt,
}: {
  accepted: boolean;
  duplicate: boolean;
  messageId?: string;
  endpointId: string;
  sequenceNumber: number;
  idempotencyKey: string;
  coreStatus: string;
  receivedAt: string;
}): EdgeTunnelAck {
  return {
    contract: C9_EDGE_TUNNEL_ACK_CONTRACT,
    version: C2_VERSION,
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

export function normalizeBroadcastDeliveryDraft(
  draft: BroadcastDeliveryDraft,
): NormalizedBroadcastDeliveryDraft {
  const errors: string[] = [];
  if (draft.contract !== C8_BROADCAST_DELIVERY_CONTRACT) {
    errors.push(`contract must equal ${JSON.stringify(C8_BROADCAST_DELIVERY_CONTRACT)}`);
  }
  if (draft.version !== C2_VERSION) {
    errors.push(`version must equal ${JSON.stringify(C2_VERSION)}`);
  }
  if (!isUuid(draft.organization_id)) {
    errors.push("organization_id must be a UUID string");
  }
  if (!isUuid(draft.broadcast_id)) {
    errors.push("broadcast_id must be a UUID string");
  }
  if (draft.delivery_path !== "C1/C2") {
    errors.push("delivery_path must equal \"C1/C2\"");
  }
  if (!Array.isArray(draft.core_contracts) || draft.core_contracts.join("/") !== "C1/C2") {
    errors.push("core_contracts must equal [\"C1\", \"C2\"]");
  }
  if (draft.sender_type !== MESSAGE_SENDER_TYPE.BROADCAST) {
    errors.push(`sender_type must equal ${JSON.stringify(MESSAGE_SENDER_TYPE.BROADCAST)}`);
  }
  if (!isPlainObject(draft.message)) {
    errors.push("message must be an object");
  }

  const message = isPlainObject(draft.message) ? draft.message : {};
  if (!isUuid(message.id)) {
    errors.push("message.id must be a UUID string");
  }
  if (!isUuid(message.idempotency_key)) {
    errors.push("message.idempotency_key must be a UUID string");
  }
  if (isUuid(message.id) && isUuid(message.idempotency_key) && message.id !== message.idempotency_key) {
    errors.push("message.idempotency_key must match message.id");
  }
  if (message.organization_id !== draft.organization_id) {
    errors.push("message.organization_id must match organization_id");
  }
  if (!isUuid(message.conversation_id)) {
    errors.push("message.conversation_id must be a UUID string");
  }
  if (!isUuid(message.endpoint_id)) {
    errors.push("message.endpoint_id must be a UUID string");
  }
  if (message.direction !== MESSAGE_DIRECTION.OUTBOUND) {
    errors.push(`message.direction must equal ${JSON.stringify(MESSAGE_DIRECTION.OUTBOUND)}`);
  }
  if (message.sender_type !== MESSAGE_SENDER_TYPE.BROADCAST) {
    errors.push(`message.sender_type must equal ${JSON.stringify(MESSAGE_SENDER_TYPE.BROADCAST)}`);
  }
  if (message.status !== MESSAGE_STATUS.ROUTED) {
    errors.push(`message.status must equal ${JSON.stringify(MESSAGE_STATUS.ROUTED)}`);
  }
  if (!Number.isSafeInteger(message.sequence_number) || (message.sequence_number as number) < 1) {
    errors.push("message.sequence_number must be a positive integer");
  }
  if (!isPlainObject(message.content)) {
    errors.push("message.content must be an object");
  }

  if (errors.length > 0) {
    throw m4BadRequest(`Invalid C8 broadcast delivery draft: ${errors.join("; ")}`);
  }

  const channel = normalizeChannel(message.channel);
  const type = normalizeMessageType(message.type);
  const createdAt = normalizeDateTime(message.created_at, "message.created_at");
  const content = message.content as Record<string, unknown>;

  return {
    organizationId: draft.organization_id as string,
    broadcastId: draft.broadcast_id as string,
    broadcastName: optionalString(draft.broadcast_name),
    message: {
      id: message.id as string,
      organization_id: draft.organization_id as string,
      conversation_id: message.conversation_id as string,
      endpoint_id: message.endpoint_id as string,
      channel,
      type,
      content: { ...content, type },
      created_at: createdAt,
    },
  };
}

function m4BadRequest(description: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED",
    description,
    humanMessage: "Некорректный M4 messaging-контракт.",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeDateTime(value: unknown, field: string): string {
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw m4BadRequest(`${field} must be a valid date-time`);
  }

  return date.toISOString();
}
