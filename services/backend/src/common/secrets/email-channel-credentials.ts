/**
 * Структурные креды email-канала (IMAP приём + SMTP отправка), Этап E0 плана
 * `docs/plan/email-channel-production.md`.
 *
 * В отличие от Telegram (один bot-токен строкой), email-канал требует набор
 * полей для двух серверов. Они сериализуются в JSON и шифруются тем же
 * envelope-механизмом ({@link ChannelSecretCipher}, AES-256-GCM) в
 * `channels.credentials_envelope` — формат envelope не меняется, «секрет» — это
 * JSON-строка вместо голого токена.
 *
 * `kind`/`version` — дискриминатор: {@link parseEmailChannelCredentials}
 * отвергает секрет, который не является email-кредами (например Telegram-токен),
 * с понятной ошибкой, а `version` оставляет пространство для миграции формата.
 * Пароли никогда не тримятся (сохраняются побайтово); host/username/from
 * нормализуются тримом.
 */

export const EMAIL_CHANNEL_CREDENTIALS_KIND = "email_channel_credentials";
export const EMAIL_CHANNEL_CREDENTIALS_VERSION = 1;

export interface EmailEndpointCredentials {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export interface EmailChannelCredentials {
  imap: EmailEndpointCredentials;
  smtp: EmailEndpointCredentials;
  from_email: string;
  from_name?: string;
}

interface SerializedEmailChannelCredentials extends EmailChannelCredentials {
  kind: typeof EMAIL_CHANNEL_CREDENTIALS_KIND;
  version: typeof EMAIL_CHANNEL_CREDENTIALS_VERSION;
}

/** Секрет канала не является структурными email-кредами (или они невалидны). */
export class EmailChannelCredentialsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailChannelCredentialsFormatError";
  }
}

/** Нормализует и сериализует email-креды в plaintext для envelope-шифрования. */
export function serializeEmailChannelCredentials(credentials: EmailChannelCredentials): string {
  const normalized = normalizeEmailChannelCredentials(credentials);
  const serialized: SerializedEmailChannelCredentials = {
    kind: EMAIL_CHANNEL_CREDENTIALS_KIND,
    version: EMAIL_CHANNEL_CREDENTIALS_VERSION,
    ...normalized,
  };

  return JSON.stringify(serialized);
}

/**
 * Разбирает расшифрованный секрет канала в структурные email-креды. Бросает
 * {@link EmailChannelCredentialsFormatError}, если это не email-креды (например
 * Telegram-токен или произвольная строка). Потребитель — Этап E2 (синхронизация
 * кред на Edge) / E3–E4 (IMAP/SMTP-драйверы).
 */
export function parseEmailChannelCredentials(plaintext: string): EmailChannelCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new EmailChannelCredentialsFormatError(
      "Channel secret is not email channel credentials (invalid JSON)",
    );
  }

  if (!isRecord(parsed) || parsed.kind !== EMAIL_CHANNEL_CREDENTIALS_KIND) {
    throw new EmailChannelCredentialsFormatError("Channel secret is not email channel credentials");
  }

  return normalizeEmailChannelCredentials(parsed);
}

/** Валидирует и нормализует произвольный вход в {@link EmailChannelCredentials}. */
export function normalizeEmailChannelCredentials(input: unknown): EmailChannelCredentials {
  if (!isRecord(input)) {
    throw new EmailChannelCredentialsFormatError("Email channel credentials must be an object");
  }

  const fromName = optionalString(input.from_name);

  return {
    imap: normalizeEndpoint(input.imap, "imap"),
    smtp: normalizeEndpoint(input.smtp, "smtp"),
    from_email: requireTrimmed(input.from_email, "from_email"),
    ...(fromName ? { from_name: fromName } : {}),
  };
}

function normalizeEndpoint(input: unknown, label: string): EmailEndpointCredentials {
  if (!isRecord(input)) {
    throw new EmailChannelCredentialsFormatError(`Email ${label} credentials must be an object`);
  }

  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EmailChannelCredentialsFormatError(
      `Email ${label}.port must be an integer in [1, 65535]`,
    );
  }

  return {
    host: requireTrimmed(input.host, `${label}.host`),
    port,
    tls: Boolean(input.tls),
    username: requireTrimmed(input.username, `${label}.username`),
    // Пароль сохраняется без тримминга: ведущие/замыкающие пробелы могут быть значимы.
    password: requirePassword(input.password, `${label}.password`),
  };
}

function requireTrimmed(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmailChannelCredentialsFormatError(`Email ${field} is required`);
  }

  return value.trim();
}

function requirePassword(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new EmailChannelCredentialsFormatError(`Email ${field} is required`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
