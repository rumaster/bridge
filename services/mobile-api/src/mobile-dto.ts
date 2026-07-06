import {
  MOBILE_API_SUPPORTED_VERSIONS,
  isSupportedMobileApiVersion,
  isMobileSyncCursor,
} from "../../../packages/contracts/src/mobile.js";

const DEVICE_REGISTRATION_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "user_id",
  "device_id",
  "platform",
  "push_provider",
  "push_token",
  "app_version",
  "locale",
]);

const SEND_MESSAGE_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "conversation_id",
  "message_id",
  "idempotency_key",
  "sender_user_id",
  "text",
  "client_generated_at",
]);

const SYNC_QUERY_FIELDS = new Set(["cursor", "device_id", "limit"]);
const DEVICE_PLATFORMS = new Set(["ios", "android"]);
const PUSH_PROVIDERS = new Set(["apns", "fcm"]);

export interface MobileDtoValidationIssue {
  field: string;
  message: string;
}

export class MobileDtoValidationError extends Error {
  readonly errors: MobileDtoValidationIssue[];

  constructor(errors) {
    super(`Mobile DTO validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "MobileDtoValidationError";
    this.errors = errors;
  }
}

export function validateDeviceRegistrationRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, DEVICE_REGISTRATION_FIELDS);
  expectConst(errors, input.contract, "MOBILE.RegisterDeviceRequest", "contract");
  expectSupportedMobileVersion(errors, input.version, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.user_id, "user_id");
  expectNonEmptyString(errors, input.device_id, "device_id");
  expectEnum(errors, input.platform, DEVICE_PLATFORMS, "platform");
  expectEnum(errors, input.push_provider, PUSH_PROVIDERS, "push_provider");
  expectNonEmptyString(errors, input.push_token, "push_token");
  expectOptionalNonEmptyString(errors, input.app_version, "app_version");
  expectOptionalNonEmptyString(errors, input.locale, "locale");

  if (input.platform === "ios" && input.push_provider !== "apns") {
    errors.push({
      field: "push_provider",
      message: "iOS devices must use the apns push provider in M0.",
    });
  }

  if (input.platform === "android" && input.push_provider !== "fcm") {
    errors.push({
      field: "push_provider",
      message: "Android devices must use the fcm push provider in M0.",
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      ...input,
      app_version: input.app_version ?? null,
      locale: input.locale ?? null,
    },
  };
}

export function validateSendMessageRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, SEND_MESSAGE_FIELDS);
  expectConst(errors, input.contract, "MOBILE.SendMessageRequest", "contract");
  expectSupportedMobileVersion(errors, input.version, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.conversation_id, "conversation_id");
  expectNonEmptyString(errors, input.message_id, "message_id");
  expectNonEmptyString(errors, input.idempotency_key, "idempotency_key");
  expectNonEmptyString(errors, input.sender_user_id, "sender_user_id");
  expectNonEmptyString(errors, input.text, "text");
  expectOptionalNonEmptyString(errors, input.client_generated_at, "client_generated_at");

  if (
    typeof input.message_id === "string" &&
    typeof input.idempotency_key === "string" &&
    input.idempotency_key !== input.message_id
  ) {
    errors.push({
      field: "idempotency_key",
      message: "idempotency_key must equal message_id for mobile sends.",
    });
  }

  if (
    typeof input.client_generated_at === "string" &&
    Number.isNaN(Date.parse(input.client_generated_at))
  ) {
    errors.push({
      field: "client_generated_at",
      message: "client_generated_at must be an ISO-8601 date-time.",
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      ...input,
      text: input.text.trim(),
      client_generated_at: input.client_generated_at ?? null,
    },
  };
}

export function validateSyncRequestQuery(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, SYNC_QUERY_FIELDS);
  expectOptionalNonEmptyString(errors, input.cursor, "cursor");
  expectOptionalNonEmptyString(errors, input.device_id, "device_id");

  if (typeof input.cursor === "string" && !isMobileSyncCursor(input.cursor)) {
    errors.push({
      field: "cursor",
      message: "cursor must use the mobile sync cursor format.",
    });
  }

  const limit = parseLimit(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    errors.push({
      field: "limit",
      message: "limit must be an integer between 1 and 500.",
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      cursor: input.cursor ?? null,
      device_id: input.device_id ?? null,
      limit,
    },
  };
}

export function assertDeviceRegistrationRequest(input) {
  const result = validateDeviceRegistrationRequest(input);
  if (!result.ok) {
    throw new MobileDtoValidationError(result.errors);
  }
  return result.value;
}

export function assertSendMessageRequest(input) {
  const result = validateSendMessageRequest(input);
  if (!result.ok) {
    throw new MobileDtoValidationError(result.errors);
  }
  return result.value;
}

export function assertSyncRequestQuery(input) {
  const result = validateSyncRequestQuery(input);
  if (!result.ok) {
    throw new MobileDtoValidationError(result.errors);
  }
  return result.value;
}

function rejectUnknownFields(errors, input, allowedFields, prefix = "") {
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      errors.push({
        field: prefix ? `${prefix}.${field}` : field,
        message: "Unexpected field.",
      });
    }
  }
}

function expectConst(errors, value, expected, field) {
  if (value !== expected) {
    errors.push({
      field,
      message: `Field must equal ${JSON.stringify(expected)}.`,
    });
  }
}

function expectSupportedMobileVersion(errors, value, field) {
  expectNonEmptyString(errors, value, field);
  if (typeof value === "string" && !isSupportedMobileApiVersion(value)) {
    errors.push({
      field,
      message: `Field must be one of ${MOBILE_API_SUPPORTED_VERSIONS.join(", ")}.`,
    });
  }
}

function expectNonEmptyString(errors, value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({
      field,
      message: "Field must be a non-empty string.",
    });
  }
}

function expectOptionalNonEmptyString(errors, value, field) {
  if (value !== undefined) {
    expectNonEmptyString(errors, value, field);
  }
}

function expectEnum(errors, value, allowedValues, field) {
  expectNonEmptyString(errors, value, field);
  if (typeof value === "string" && !allowedValues.has(value)) {
    errors.push({
      field,
      message: `Field must be one of ${Array.from(allowedValues).join(", ")}.`,
    });
  }
}

function parseLimit(value) {
  if (value === undefined) {
    return 100;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return Number.NaN;
}

function invalidPayload() {
  return {
    ok: false,
    errors: [
      {
        field: "$",
        message: "Payload must be a JSON object.",
      },
    ],
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
