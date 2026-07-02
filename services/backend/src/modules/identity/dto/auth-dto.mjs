const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const TELEGRAM_CODE_PATTERN = /^[0-9]{6}$/;

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

  const errors = unknownFields(input, new Set(["telegramUsername", "code"]));
  const telegramUsername = normalizeTelegramUsername(input.telegramUsername);
  const code = typeof input.code === "string" ? input.code.trim() : null;

  if (!telegramUsername) {
    errors.push({
      field: "telegramUsername",
      message:
        "Telegram username must contain 5-32 letters, digits or underscores, with optional @ prefix.",
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
      code,
    },
  };
}
