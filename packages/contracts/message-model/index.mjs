export const MESSAGE_MODEL_CONTRACT_ID = "C1";
export const MESSAGE_MODEL_VERSION = "1.0.0";

export const MESSAGE_CHANNEL = Object.freeze({
  TELEGRAM: "telegram",
  MAX: "max",
  VK: "vk",
  WHATSAPP: "whatsapp",
  WEB_CHAT: "web_chat",
  EMAIL: "email",
  SMS: "sms",
});

export const MESSAGE_DIRECTION = Object.freeze({
  INBOUND: "inbound",
  OUTBOUND: "outbound",
});

export const MESSAGE_SENDER_TYPE = Object.freeze({
  CLIENT: "client",
  MANAGER: "manager",
  AI: "ai",
  BROADCAST: "broadcast",
  SYSTEM: "system",
});

export const MESSAGE_TYPE = Object.freeze({
  TEXT: "text",
  IMAGE: "image",
  FILE: "file",
  AUDIO: "audio",
  VIDEO: "video",
  LOCATION: "location",
  COMMAND: "command",
  EVENT: "event",
  SYSTEM: "system",
});

export const MESSAGE_STATUS = Object.freeze({
  RECEIVED: "received",
  ROUTED: "routed",
  SENT: "sent",
  DELIVERED: "delivered",
  FAILED: "failed",
});

export const MESSAGE_STATUS_TRANSITIONS = Object.freeze({
  [MESSAGE_STATUS.RECEIVED]: Object.freeze([
    MESSAGE_STATUS.ROUTED,
    MESSAGE_STATUS.FAILED,
  ]),
  [MESSAGE_STATUS.ROUTED]: Object.freeze([
    MESSAGE_STATUS.SENT,
    MESSAGE_STATUS.FAILED,
  ]),
  [MESSAGE_STATUS.SENT]: Object.freeze([
    MESSAGE_STATUS.DELIVERED,
    MESSAGE_STATUS.FAILED,
  ]),
  [MESSAGE_STATUS.DELIVERED]: Object.freeze([]),
  [MESSAGE_STATUS.FAILED]: Object.freeze([]),
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const requiredCanonicalMessageFields = Object.freeze([
  "id",
  "idempotency_key",
  "organization_id",
  "conversation_id",
  "endpoint_id",
  "channel",
  "direction",
  "sender_type",
  "sequence_number",
  "type",
  "content",
  "status",
  "created_at",
  "updated_at",
]);

const timestampFields = Object.freeze([
  "created_at",
  "updated_at",
  "received_at",
  "routed_at",
  "sent_at",
  "delivered_at",
  "failed_at",
]);

function enumValues(source) {
  return Object.values(source);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function validateRequiredFields(message, errors) {
  for (const field of requiredCanonicalMessageFields) {
    if (!hasMeaningfulValue(message[field])) {
      errors.push(`${field} is required`);
    }
  }
}

function validateUuidField(message, field, errors) {
  if (!hasMeaningfulValue(message[field])) {
    return;
  }

  if (typeof message[field] !== "string" || !UUID_PATTERN.test(message[field])) {
    errors.push(`${field} must be a UUID string`);
  }
}

function validateEnumField(message, field, allowedValues, errors) {
  if (!hasMeaningfulValue(message[field])) {
    return;
  }

  if (!allowedValues.includes(message[field])) {
    errors.push(`${field} must be one of: ${allowedValues.join(", ")}`);
  }
}

function validateTimestampField(message, field, errors) {
  if (!hasMeaningfulValue(message[field])) {
    return;
  }

  if (
    typeof message[field] !== "string" ||
    !ISO_DATE_TIME_PATTERN.test(message[field]) ||
    Number.isNaN(Date.parse(message[field]))
  ) {
    errors.push(`${field} must be an ISO-8601 UTC timestamp`);
  }
}

function validateAttachment(attachment, index, errors) {
  if (!isPlainObject(attachment)) {
    errors.push(`attachments[${index}] must be an object`);
    return;
  }

  for (const field of ["id", "kind", "storage_ref", "mime", "size"]) {
    if (!hasMeaningfulValue(attachment[field])) {
      errors.push(`attachments[${index}].${field} is required`);
    }
  }

  validateUuidField(attachment, "id", errors);

  if (
    hasMeaningfulValue(attachment.size) &&
    (!Number.isSafeInteger(attachment.size) || attachment.size < 0)
  ) {
    errors.push(`attachments[${index}].size must be a non-negative integer`);
  }
}

export function validateCanonicalMessage(message) {
  const errors = [];

  if (!isPlainObject(message)) {
    return {
      valid: false,
      errors: ["message must be an object"],
    };
  }

  validateRequiredFields(message, errors);

  for (const field of [
    "id",
    "idempotency_key",
    "organization_id",
    "conversation_id",
    "endpoint_id",
    "client_id",
  ]) {
    validateUuidField(message, field, errors);
  }

  if (
    hasMeaningfulValue(message.id) &&
    hasMeaningfulValue(message.idempotency_key) &&
    message.id !== message.idempotency_key
  ) {
    errors.push("idempotency_key must match id");
  }

  validateEnumField(message, "channel", enumValues(MESSAGE_CHANNEL), errors);
  validateEnumField(message, "direction", enumValues(MESSAGE_DIRECTION), errors);
  validateEnumField(message, "sender_type", enumValues(MESSAGE_SENDER_TYPE), errors);
  validateEnumField(message, "type", enumValues(MESSAGE_TYPE), errors);
  validateEnumField(message, "status", enumValues(MESSAGE_STATUS), errors);

  if (
    hasMeaningfulValue(message.sequence_number) &&
    (!Number.isSafeInteger(message.sequence_number) || message.sequence_number < 1)
  ) {
    errors.push("sequence_number must be a positive integer");
  }

  if (hasMeaningfulValue(message.content) && !isPlainObject(message.content)) {
    errors.push("content must be an object");
  }

  if (hasMeaningfulValue(message.attachments)) {
    if (!Array.isArray(message.attachments)) {
      errors.push("attachments must be an array");
    } else {
      message.attachments.forEach((attachment, index) => {
        validateAttachment(attachment, index, errors);
      });
    }
  }

  for (const field of timestampFields) {
    validateTimestampField(message, field, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function assertMessageStatusTransition(fromStatus, toStatus) {
  return MESSAGE_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus) === true;
}

export function transitionMessageStatus(message, toStatus, changedAt = new Date().toISOString()) {
  if (!assertMessageStatusTransition(message.status, toStatus)) {
    throw new Error(`Invalid message status transition: ${message.status} -> ${toStatus}`);
  }

  const timestampFieldByStatus = {
    [MESSAGE_STATUS.RECEIVED]: "received_at",
    [MESSAGE_STATUS.ROUTED]: "routed_at",
    [MESSAGE_STATUS.SENT]: "sent_at",
    [MESSAGE_STATUS.DELIVERED]: "delivered_at",
    [MESSAGE_STATUS.FAILED]: "failed_at",
  };

  return {
    ...message,
    status: toStatus,
    updated_at: changedAt,
    [timestampFieldByStatus[toStatus]]: changedAt,
  };
}
