const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMPTZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function assertUuid(value, fieldName = "uuid") {
  if (!isUuid(value)) {
    throw new TypeError(`${fieldName} must be an RFC 4122 UUID string`);
  }

  return value;
}

export function toUtcTimestamptz(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("timestamptz value must be parseable as a date");
  }

  return date.toISOString();
}

export function isUtcTimestamptz(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMPTZ_PATTERN.test(value)) {
    return false;
  }

  return toUtcTimestamptz(value) === value;
}

export function assertUtcTimestamptz(value, fieldName = "timestamptz") {
  if (!isUtcTimestamptz(value)) {
    throw new TypeError(`${fieldName} must be an ISO 8601 UTC timestamptz string`);
  }

  return value;
}
