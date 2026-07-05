import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Шифрование payload для RF-буфера Edge (`edge_message_buffer.payload_encrypted`,
 * ТЗ §7.9, §7.14, CP-7).
 *
 * Канонический payload C1 шифруется симметрично (AES-256-GCM) перед первичной
 * фиксацией в RF-контуре: буфер хранит только шифртекст (`bytea`), ключ живёт в
 * централизованном секрет-менеджере (мастер §2), а не в коде. Auth tag GCM даёт
 * контроль целостности — искажение шифртекста или подмена AAD (endpoint_id /
 * sequence_number / idempotency_key записи) приводит к отказу дешифрования.
 *
 * Формат конверта `payload_encrypted` (bytea):
 *   [ версия(1) | iv(12) | authTag(16) | ciphertext(...) ]
 */

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;

/** Требуемая длина ключа шифрования RF-буфера (AES-256). */
export const RF_PAYLOAD_KEY_BYTES = 32;

export class RfPayloadCipherError extends Error {
  constructor(message) {
    super(message);
    this.name = "RfPayloadCipherError";
  }
}

function normalizeKey(key) {
  if (Buffer.isBuffer(key)) {
    return key;
  }
  if (typeof key === "string") {
    const trimmed = key.trim();
    // Ключ секрет-менеджера приходит как base64; поддерживаем и hex/utf8 длины 32.
    for (const encoding of ["base64", "hex"] as const) {
      const candidate = Buffer.from(trimmed, encoding);
      if (candidate.length === RF_PAYLOAD_KEY_BYTES) {
        return candidate;
      }
    }
    return Buffer.from(trimmed, "utf8");
  }
  throw new RfPayloadCipherError("encryption key must be a Buffer or string");
}

function normalizeAad(aad) {
  if (aad === undefined || aad === null) {
    return undefined;
  }
  if (Buffer.isBuffer(aad)) {
    return aad;
  }
  if (typeof aad === "string") {
    return Buffer.from(aad, "utf8");
  }
  // Стабильная сериализация связующих полей записи (endpoint_id, sequence_number,
  // idempotency_key) — порядок ключей фиксируем, чтобы AAD был воспроизводим.
  const ordered = {};
  for (const field of Object.keys(aad).sort()) {
    ordered[field] = aad[field];
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/**
 * @param {object} options
 * @param {Buffer|string} options.key ключ AES-256 (32 байта) из секрет-менеджера
 * @param {() => Buffer} [options.ivFactory] генератор IV (по умолчанию randomBytes)
 */
export interface CreateRfPayloadCipherOptions {
  key?: Buffer | string;
  ivFactory?: () => Buffer;
}

export interface RfPayloadCipherAadOptions {
  aad?: object | Buffer | string;
}

export function createRfPayloadCipher({
  key,
  ivFactory = () => randomBytes(IV_BYTES),
}: CreateRfPayloadCipherOptions = {}) {
  if (key === undefined || key === null || key === "") {
    throw new RfPayloadCipherError("encryption key is required (secret manager)");
  }

  const secret = normalizeKey(key);
  if (secret.length !== RF_PAYLOAD_KEY_BYTES) {
    throw new RfPayloadCipherError(
      `encryption key must be ${RF_PAYLOAD_KEY_BYTES} bytes (AES-256), got ${secret.length}`,
    );
  }

  return {
    /**
     * Шифрует канонический payload в конверт `payload_encrypted`.
     * @param {object} payload C1-сообщение
     * @param {object} [options]
     * @param {object|Buffer|string} [options.aad] дополнительные аутентифицируемые данные
     * @returns {Buffer}
     */
    encrypt(payload, { aad }: RfPayloadCipherAadOptions = {}) {
      if (payload === undefined || payload === null) {
        throw new RfPayloadCipherError("payload is required for encryption");
      }

      const iv = ivFactory();
      if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
        throw new RfPayloadCipherError(`iv must be ${IV_BYTES} bytes`);
      }

      const cipher = createCipheriv(ALGORITHM, secret, iv);
      const normalizedAad = normalizeAad(aad);
      if (normalizedAad) {
        cipher.setAAD(normalizedAad);
      }

      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, authTag, ciphertext]);
    },

    /**
     * Дешифрует конверт `payload_encrypted` обратно в canonical payload.
     * @param {Buffer} envelope
     * @param {object} [options]
     * @param {object|Buffer|string} [options.aad]
     * @returns {object}
     */
    decrypt(envelope, { aad }: RfPayloadCipherAadOptions = {}) {
      const buffer = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope ?? []);
      if (buffer.length < HEADER_BYTES) {
        throw new RfPayloadCipherError("encrypted payload is too short");
      }
      if (buffer[0] !== ENVELOPE_VERSION) {
        throw new RfPayloadCipherError(`unsupported payload_encrypted version ${buffer[0]}`);
      }

      const iv = buffer.subarray(1, 1 + IV_BYTES);
      const authTag = buffer.subarray(1 + IV_BYTES, HEADER_BYTES);
      const ciphertext = buffer.subarray(HEADER_BYTES);

      const decipher = createDecipheriv(ALGORITHM, secret, iv);
      const normalizedAad = normalizeAad(aad);
      if (normalizedAad) {
        decipher.setAAD(normalizedAad);
      }
      decipher.setAuthTag(authTag);

      let plaintext;
      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // Искажён шифртекст, IV, tag или не совпал AAD — целостность нарушена.
        throw new RfPayloadCipherError("payload integrity check failed (auth tag mismatch)");
      }

      try {
        return JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new RfPayloadCipherError("decrypted payload is not valid JSON");
      }
    },
  };
}

/**
 * Достаёт ключ шифрования RF-буфера из окружения (секрет-менеджер), НЕ из кода.
 * @param {object} [env] источник переменных (по умолчанию process.env)
 * @param {string} [variableName]
 * @returns {Buffer}
 */
export function resolveRfPayloadKey(env = process.env, variableName = "EDGE_BUFFER_ENCRYPTION_KEY") {
  const raw = env?.[variableName];
  if (!raw) {
    throw new RfPayloadCipherError(
      `RF buffer encryption key is not configured (${variableName} via secret manager)`,
    );
  }
  const key = normalizeKey(raw);
  if (key.length !== RF_PAYLOAD_KEY_BYTES) {
    throw new RfPayloadCipherError(
      `${variableName} must decode to ${RF_PAYLOAD_KEY_BYTES} bytes (AES-256)`,
    );
  }
  return key;
}

/**
 * Сравнение двух ключей в постоянном времени (для проверок конфигурации/тестов).
 */
export function keysEqual(a, b) {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
