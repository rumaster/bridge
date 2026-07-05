import {
  C10_VERSION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  validateNotificationTriggerEvent,
} from "../../../packages/contracts/src/c10.js";

const SETTINGS_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "user_id",
  "settings",
]);

const SETTING_FIELDS = new Set(["category", "channel", "enabled"]);

/** Единичное нарушение валидации DTO C10. */
export interface C10ValidationIssue {
  field: string;
  message: string;
}

export class C10DtoValidationError extends Error {
  readonly errors: C10ValidationIssue[];

  constructor(errors: C10ValidationIssue[]) {
    super(`C10 DTO validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "C10DtoValidationError";
    this.errors = errors;
  }
}

export function validateListNotificationsQuery(input: unknown = {}) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  expectOptionalOneOf(errors, input.status, NOTIFICATION_STATUSES, "status");
  expectOptionalOneOf(errors, input.category, NOTIFICATION_CATEGORIES, "category");
  expectOptionalNonEmptyString(errors, input.cursor, "cursor");

  const limit = normalizeLimit(input.limit, errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      status: input.status,
      category: input.category,
      cursor: input.cursor,
      limit,
    },
  };
}

export function validateUpdateNotificationSettingsRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, SETTINGS_FIELDS);
  expectConst(errors, input.contract, "C10.UpdateNotificationSettingsRequest", "contract");
  expectConst(errors, input.version, C10_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.user_id, "user_id");

  if (!Array.isArray(input.settings) || input.settings.length === 0) {
    errors.push({
      field: "settings",
      message: "settings must contain at least one item.",
    });
  } else {
    input.settings.forEach((setting, index) => {
      validateSetting(errors, setting, `settings[${index}]`);
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
      settings: (input.settings as Array<Record<string, unknown>>).map((setting) => ({
        ...setting,
      })),
    },
  };
}

export function validateNotificationTriggerEventPayload(input) {
  const result = validateNotificationTriggerEvent(input);

  if (!result.valid) {
    return {
      ok: false,
      errors: result.errors.map((error) => ({
        field: schemaErrorField(error),
        message: error,
      })),
    };
  }

  return {
    ok: true,
    value: input,
  };
}

export function assertListNotificationsQuery(input) {
  const result = validateListNotificationsQuery(input);
  if (!result.ok) {
    throw new C10DtoValidationError(result.errors);
  }
  return result.value;
}

/** Проверенный запрос обновления настроек уведомлений (C10). */
export interface UpdateNotificationSettingsRequestDto {
  contract: string;
  version: string;
  request_id: string;
  organization_id: string;
  user_id: string;
  settings: Array<Record<string, unknown>>;
}

export function assertUpdateNotificationSettingsRequest(
  input,
): UpdateNotificationSettingsRequestDto {
  const result = validateUpdateNotificationSettingsRequest(input);
  if (!result.ok) {
    throw new C10DtoValidationError(result.errors);
  }
  return result.value as UpdateNotificationSettingsRequestDto;
}

export function assertNotificationTriggerEventPayload(input) {
  const result = validateNotificationTriggerEventPayload(input);
  if (!result.ok) {
    throw new C10DtoValidationError(result.errors);
  }
  return result.value;
}

function validateSetting(errors, setting, path) {
  if (!isRecord(setting)) {
    errors.push({
      field: path,
      message: "setting must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, setting, SETTING_FIELDS, path);
  expectOneOf(errors, setting.category, NOTIFICATION_CATEGORIES, `${path}.category`);
  expectOneOf(errors, setting.channel, NOTIFICATION_CHANNELS, `${path}.channel`);

  if (typeof setting.enabled !== "boolean") {
    errors.push({
      field: `${path}.enabled`,
      message: "enabled must be a boolean.",
    });
  }
}

function normalizeLimit(value, errors) {
  if (value === undefined || value === null || value === "") {
    return 50;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    errors.push({
      field: "limit",
      message: "limit must be an integer between 1 and 100.",
    });
    return 50;
  }

  return parsed;
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

function expectOptionalOneOf(errors, value, allowed, field) {
  if (value !== undefined) {
    expectOneOf(errors, value, allowed, field);
  }
}

function expectOneOf(errors, value, allowed, field) {
  if (!allowed.includes(value)) {
    errors.push({
      field,
      message: `Field must be one of ${allowed.join(", ")}.`,
    });
  }
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

function schemaErrorField(error) {
  const match = error.match(/^\$\.([^\s]+)/);
  return match ? match[1] : "$";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
