const VALID_ACTIONS = new Set(["replace", "clear", "mark"]);
const REQUIRED_CLIENT_FIELD_KEYS = new Set([
  "clients.display_name",
  "clients.anonymized_at",
  "communication_endpoints.external_id",
  "communication_endpoints.verified",
  "communication_endpoints.verified_at",
  "communication_endpoints.metadata",
  "client_identity_links.evidence",
  "client_identity_links.reverted_reason",
  "messages.content",
  "attachments.storage_ref",
  "attachments.metadata",
  "message_delivery_attempts.error",
  "client_notes.body",
  "client_tags.tag",
]);

export const CLIENT_ANONYMIZATION_FIELDS = [
  {
    key: "clients.display_name",
    table: "clients",
    column: "display_name",
    action: "clear",
    personalDataClass: "client_profile",
  },
  {
    key: "clients.anonymized_at",
    table: "clients",
    column: "anonymized_at",
    action: "mark",
    personalDataClass: "erasure_marker",
  },
  {
    key: "communication_endpoints.external_id",
    table: "communication_endpoints",
    column: "external_id",
    action: "replace",
    personalDataClass: "external_identifier",
  },
  {
    key: "communication_endpoints.verified",
    table: "communication_endpoints",
    column: "verified",
    action: "clear",
    personalDataClass: "external_identifier",
  },
  {
    key: "communication_endpoints.verified_at",
    table: "communication_endpoints",
    column: "verified_at",
    action: "clear",
    personalDataClass: "external_identifier",
  },
  {
    key: "communication_endpoints.metadata",
    table: "communication_endpoints",
    column: "metadata",
    action: "replace",
    personalDataClass: "external_identifier",
  },
  {
    key: "client_identity_links.evidence",
    table: "client_identity_links",
    column: "evidence",
    action: "replace",
    personalDataClass: "identity_evidence",
  },
  {
    key: "client_identity_links.reverted_reason",
    table: "client_identity_links",
    column: "reverted_reason",
    action: "replace",
    personalDataClass: "identity_evidence",
  },
  {
    key: "messages.content",
    table: "messages",
    column: "content",
    action: "replace",
    personalDataClass: "communication_history",
  },
  {
    key: "attachments.storage_ref",
    table: "attachments",
    column: "storage_ref",
    action: "replace",
    personalDataClass: "communication_history",
  },
  {
    key: "attachments.metadata",
    table: "attachments",
    column: "metadata",
    action: "replace",
    personalDataClass: "communication_history",
  },
  {
    key: "message_delivery_attempts.error",
    table: "message_delivery_attempts",
    column: "error",
    action: "clear",
    personalDataClass: "delivery_trace",
  },
  {
    key: "client_notes.body",
    table: "client_notes",
    column: "body",
    action: "replace",
    personalDataClass: "client_profile",
  },
  {
    key: "client_tags.tag",
    table: "client_tags",
    column: "tag",
    action: "replace",
    personalDataClass: "client_profile",
  },
];

export function validateClientAnonymizationFields(
  fields = CLIENT_ANONYMIZATION_FIELDS,
  requiredKeys = REQUIRED_CLIENT_FIELD_KEYS,
) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new TypeError("client anonymization fields must be a non-empty array");
  }

  const seenKeys = new Set();

  for (const field of fields) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) {
      throw new TypeError("client anonymization field must be an object");
    }

    for (const property of ["key", "table", "column", "action", "personalDataClass"]) {
      if (typeof field[property] !== "string" || field[property].trim() === "") {
        throw new TypeError(`client anonymization field ${property} must be a non-blank string`);
      }
    }

    if (field.key !== `${field.table}.${field.column}`) {
      throw new TypeError(`client anonymization field ${field.key} must match table.column`);
    }

    if (seenKeys.has(field.key)) {
      throw new TypeError(`duplicate client anonymization field: ${field.key}`);
    }
    seenKeys.add(field.key);

    if (!VALID_ACTIONS.has(field.action)) {
      throw new TypeError(`client anonymization field ${field.key} has unsupported action`);
    }
  }

  for (const requiredKey of requiredKeys) {
    if (!seenKeys.has(requiredKey)) {
      throw new TypeError(`missing required client anonymization field: ${requiredKey}`);
    }
  }

  return fields;
}
