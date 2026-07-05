import {
  MOBILE_SYNC_CURSOR_PREFIX,
} from "../../../packages/contracts/src/mobile.js";

export interface MobileSyncCursorIssue {
  field: string;
  message: string;
}

export interface MobileSyncCursorResult {
  ok: boolean;
  value?: any;
  errors?: MobileSyncCursorIssue[];
}

export class MobileSyncCursorError extends Error {
  readonly errors: MobileSyncCursorIssue[];

  constructor(errors) {
    super(`Mobile sync cursor validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "MobileSyncCursorError";
    this.errors = errors;
  }
}

export function createSyncCursor({
  organizationId,
  userId,
  deviceId,
  sequence,
  issuedAt = new Date().toISOString(),
}) {
  const payload = {
    v: 1,
    organization_id: organizationId,
    user_id: userId,
    device_id: deviceId,
    sequence,
    issued_at: issuedAt,
  };
  const validation = validateCursorPayload(payload);

  if (!validation.ok) {
    throw new MobileSyncCursorError(validation.errors);
  }

  return `${MOBILE_SYNC_CURSOR_PREFIX}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

export function parseSyncCursor(cursor): MobileSyncCursorResult {
  if (typeof cursor !== "string" || cursor.trim() === "") {
    return invalidCursor("cursor", "cursor must be a non-empty string.");
  }

  const [prefix, encoded, extra] = cursor.split(".");
  if (prefix !== MOBILE_SYNC_CURSOR_PREFIX || !encoded || extra !== undefined) {
    return invalidCursor(
      "cursor",
      `cursor must use the ${MOBILE_SYNC_CURSOR_PREFIX}.<base64url-json> format.`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return invalidCursor("cursor", "cursor payload must be valid base64url JSON.");
  }

  return validateCursorPayload(payload);
}

export function assertSyncCursor(cursor) {
  const result = parseSyncCursor(cursor);
  if (!result.ok) {
    throw new MobileSyncCursorError(result.errors);
  }
  return result.value;
}

function validateCursorPayload(payload): MobileSyncCursorResult {
  const errors = [];

  if (!isRecord(payload)) {
    return invalidCursor("cursor", "cursor payload must be a JSON object.");
  }

  expectConst(errors, payload.v, 1, "v");
  expectNonEmptyString(errors, payload.organization_id, "organization_id");
  expectNonEmptyString(errors, payload.user_id, "user_id");
  expectNonEmptyString(errors, payload.device_id, "device_id");

  if (!Number.isInteger(payload.sequence) || payload.sequence < 0) {
    errors.push({
      field: "sequence",
      message: "sequence must be a non-negative integer.",
    });
  }

  expectNonEmptyString(errors, payload.issued_at, "issued_at");
  if (
    typeof payload.issued_at === "string" &&
    Number.isNaN(Date.parse(payload.issued_at))
  ) {
    errors.push({
      field: "issued_at",
      message: "issued_at must be an ISO-8601 date-time.",
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
    value: payload,
  };
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

function invalidCursor(field, message): MobileSyncCursorResult {
  return {
    ok: false,
    errors: [
      {
        field,
        message,
      },
    ],
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
