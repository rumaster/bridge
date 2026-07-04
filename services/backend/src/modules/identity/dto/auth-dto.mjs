const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const TELEGRAM_CODE_PATTERN = /^[0-9]{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_CODES = new Set(["administrator", "manager"]);
const CONTACT_TYPES = new Set(["email", "telegram"]);
const MAX_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTelegramUsername(value) {
  if (typeof value !== "string") {
    return null;
  }

  const withoutPrefix = value.trim().replace(/^@/, "");
  if (!TELEGRAM_USERNAME_PATTERN.test(withoutPrefix)) {
    return null;
  }

  return withoutPrefix.toLowerCase();
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    return null;
  }

  return email;
}

function normalizeContactValue(contactType, value) {
  if (contactType === "email") {
    return normalizeEmail(value);
  }

  if (contactType === "telegram") {
    return normalizeTelegramUsername(value);
  }

  return null;
}

function normalizeDisplayName(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    return required ? null : undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    return null;
  }

  return displayName;
}

function normalizeOptionalText(value, maxLength) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    return null;
  }

  return text;
}

function normalizePositiveInteger(value, { max, min = 1 }) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

function unknownFields(input, allowedFields) {
  return Object.keys(input)
    .filter((field) => !allowedFields.has(field))
    .map((field) => ({
      field,
      message: "Unexpected field.",
    }));
}

function invalidPayload(message = "Payload must be a JSON object.") {
  return {
    ok: false,
    errors: [
      {
        field: "$",
        message,
      },
    ],
  };
}

export function validateTelegramLoginStartRequest(input) {
  if (!isRecord(input)) {
    return invalidPayload();
  }

  const errors = unknownFields(input, new Set(["telegramUsername"]));
  const telegramUsername = normalizeTelegramUsername(input.telegramUsername);

  if (!telegramUsername) {
    errors.push({
      field: "telegramUsername",
      message:
        "Telegram username must contain 5-32 letters, digits or underscores, with optional @ prefix.",
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
      telegramUsername,
    },
  };
}

export function validateTelegramLoginVerifyRequest(input) {
  if (!isRecord(input)) {
    return invalidPayload();
  }

  const errors = unknownFields(
    input,
    new Set(["telegramUsername", "requestId", "code"]),
  );
  const telegramUsername =
    input.telegramUsername === undefined
      ? null
      : normalizeTelegramUsername(input.telegramUsername);
  const requestId =
    typeof input.requestId === "string" && UUID_PATTERN.test(input.requestId)
      ? input.requestId
      : null;
  const code = typeof input.code === "string" ? input.code.trim() : null;

  if (!telegramUsername && !requestId) {
    errors.push({
      field: "telegramUsername",
      message:
        "Either telegramUsername or requestId must identify a Telegram login challenge.",
    });
  }

  if (input.telegramUsername !== undefined && !telegramUsername) {
    errors.push({
      field: "telegramUsername",
      message:
        "Telegram username must contain 5-32 letters, digits or underscores, with optional @ prefix.",
    });
  }

  if (input.requestId !== undefined && !requestId) {
    errors.push({
      field: "requestId",
      message: "Telegram login requestId must be an RFC 4122 UUID string.",
    });
  }

  if (!code || !TELEGRAM_CODE_PATTERN.test(code)) {
    errors.push({
      field: "code",
      message: "Telegram login code must contain exactly 6 digits.",
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
      telegramUsername,
      requestId,
      code,
    },
  };
}

export function validatePlatformOrganizationProvisionRequest(input) {
  if (!isRecord(input)) {
    return invalidPayload();
  }

  const errors = unknownFields(
    input,
    new Set(["name", "description", "timezone", "locale"]),
  );
  const name = normalizeDisplayName(input.name, { required: true });
  const description = normalizeOptionalText(input.description, 1000);
  const timezone = normalizeOptionalText(input.timezone, 64);
  const locale = normalizeOptionalText(input.locale, 16);

  if (!name) {
    errors.push({
      field: "name",
      message: "Organization name must be a non-empty string up to 200 characters.",
    });
  }

  if (description === null && input.description !== null) {
    errors.push({
      field: "description",
      message: "Organization description must be a non-empty string up to 1000 characters.",
    });
  }

  if (timezone === null) {
    errors.push({
      field: "timezone",
      message: "Organization timezone must be a non-empty string up to 64 characters.",
    });
  }

  if (locale === null) {
    errors.push({
      field: "locale",
      message: "Organization locale must be a non-empty string up to 16 characters.",
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
      name,
      description: description === undefined ? null : description,
      timezone: timezone ?? "UTC",
      locale: locale ?? "ru-RU",
    },
  };
}

export function validateCreateOrganizationAdministratorRequest(input) {
  return validateInvitationPayload(input, {
    allowedFields: new Set(["contactType", "contactValue", "displayName", "expiresInSeconds"]),
    defaultRoleCode: "administrator",
    requireOrganizationId: false,
  });
}

export function validateCreateInvitationRequest(input) {
  return validateInvitationPayload(input, {
    allowedFields: new Set([
      "organizationId",
      "contactType",
      "contactValue",
      "displayName",
      "roleCode",
      "expiresInSeconds",
    ]),
    defaultRoleCode: "manager",
    requireOrganizationId: true,
  });
}

export function validateAcceptInvitationRequest(input) {
  if (!isRecord(input)) {
    return invalidPayload();
  }

  const errors = unknownFields(input, new Set(["token", "displayName"]));
  const token =
    typeof input.token === "string" && input.token.trim().length >= 16
      ? input.token.trim()
      : null;
  const displayName = normalizeDisplayName(input.displayName);

  if (!token) {
    errors.push({
      field: "token",
      message: "Invitation token must be a non-empty opaque token string.",
    });
  }

  if (displayName === null) {
    errors.push({
      field: "displayName",
      message: "Display name must be a non-empty string up to 200 characters.",
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
      token,
      displayName,
    },
  };
}

function validateInvitationPayload(
  input,
  { allowedFields, defaultRoleCode, requireOrganizationId },
) {
  if (!isRecord(input)) {
    return invalidPayload();
  }

  const errors = unknownFields(input, allowedFields);
  const organizationId =
    typeof input.organizationId === "string" && UUID_PATTERN.test(input.organizationId)
      ? input.organizationId
      : null;
  const contactType = typeof input.contactType === "string" ? input.contactType.trim() : null;
  const contactValue = normalizeContactValue(contactType, input.contactValue);
  const displayName = normalizeDisplayName(input.displayName);
  const roleCode =
    input.roleCode === undefined
      ? defaultRoleCode
      : typeof input.roleCode === "string" && ROLE_CODES.has(input.roleCode)
        ? input.roleCode
        : null;
  const expiresInSeconds = normalizePositiveInteger(input.expiresInSeconds, {
    max: MAX_INVITATION_TTL_SECONDS,
  });

  if (requireOrganizationId && !organizationId) {
    errors.push({
      field: "organizationId",
      message: "Organization id must be an RFC 4122 UUID string.",
    });
  }

  if (!contactType || !CONTACT_TYPES.has(contactType)) {
    errors.push({
      field: "contactType",
      message: "Invitation contactType must be email or telegram.",
    });
  }

  if (!contactValue) {
    errors.push({
      field: "contactValue",
      message: "Invitation contactValue must match the selected contactType.",
    });
  }

  if (displayName === null) {
    errors.push({
      field: "displayName",
      message: "Display name must be a non-empty string up to 200 characters.",
    });
  }

  if (!roleCode) {
    errors.push({
      field: "roleCode",
      message: "Invitation roleCode must be administrator or manager.",
    });
  }

  if (expiresInSeconds === null) {
    errors.push({
      field: "expiresInSeconds",
      message: "Invitation TTL must be an integer between 1 second and 30 days.",
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
      ...(requireOrganizationId ? { organizationId } : {}),
      contactType,
      contactValue,
      displayName,
      roleCode,
      expiresInSeconds,
    },
  };
}
