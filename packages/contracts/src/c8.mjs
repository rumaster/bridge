import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.mjs";
import { validateCanonicalMessage } from "../message-model/index.mjs";

export const C8_VERSION = "1.0.0";

export const BROADCAST_STATUSES = Object.freeze([
  "draft",
  "scheduled",
  "running",
  "done",
  "failed",
]);

export const BROADCAST_STATE_CHANGED_EVENT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "contract",
    "version",
    "event",
    "event_id",
    "organization_id",
    "broadcast_id",
    "previous_status",
    "status",
    "changed_at",
  ],
});

export const BROADCAST_CORE_DELIVERY_DRAFT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c8-core-delivery-draft.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function createBroadcastCoreDeliveryDraft({
  broadcastId,
  organizationId,
  messageId,
  conversationId,
  endpointId,
  channel,
  text,
  sequenceNumber = 1,
  createdAt = new Date().toISOString(),
}) {
  return {
    contract: "C8.BroadcastCoreDeliveryDraft",
    version: C8_VERSION,
    broadcast_id: broadcastId,
    organization_id: organizationId,
    delivery_path: "C1/C2",
    core_contracts: ["C1", "C2"],
    sender_type: "broadcast",
    message: {
      id: messageId,
      idempotency_key: messageId,
      organization_id: organizationId,
      conversation_id: conversationId,
      endpoint_id: endpointId,
      channel,
      direction: "outbound",
      sender_type: "broadcast",
      sequence_number: sequenceNumber,
      type: "text",
      content: {
        text,
        broadcast_id: broadcastId,
      },
      status: "routed",
      created_at: createdAt,
      updated_at: createdAt,
      metadata: {
        broadcast_id: broadcastId,
        origin: "SVC-BCAST",
      },
    },
  };
}

export function validateBroadcastCoreDeliveryDraft(draft) {
  const schemaValidation = validateJsonSchema(
    draft,
    BROADCAST_CORE_DELIVERY_DRAFT_SCHEMA,
  );
  const messageValidation =
    draft && typeof draft === "object" && !Array.isArray(draft)
      ? validateCanonicalMessage(draft.message)
      : {
          valid: false,
          errors: ["message must be a canonical C1 object"],
        };

  return {
    valid: schemaValidation.valid && messageValidation.valid,
    errors: [...schemaValidation.errors, ...messageValidation.errors],
  };
}

export function createBroadcastStateChangedEvent({
  eventId,
  organizationId,
  broadcastId,
  previousStatus = null,
  status,
  changedAt = new Date().toISOString(),
  reason,
}) {
  if (!BROADCAST_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported broadcast status: ${status}`);
  }

  if (previousStatus !== null && !BROADCAST_STATUSES.includes(previousStatus)) {
    throw new TypeError(`Unsupported previous broadcast status: ${previousStatus}`);
  }

  return {
    contract: "C7.BroadcastStateChangedEvent",
    version: C8_VERSION,
    event: "broadcast.state_changed",
    event_id: eventId,
    organization_id: organizationId,
    broadcast_id: broadcastId,
    previous_status: previousStatus,
    status,
    changed_at: changedAt,
    ...(reason ? { reason } : {}),
  };
}
