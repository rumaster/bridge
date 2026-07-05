/**
 * Классификация ошибок доставки во внешний канал (ТЗ §10.8).
 *
 * SVC-INT доставляет сообщения через адаптеры каналов и обязан отличать
 * **повторяемые** (temporary) ошибки — троттлинг, таймауты, 5xx внешнего API —
 * от **неповторяемых** (permanent) — некорректный запрос, отказ авторизации.
 * Повторяемые уходят в ретрай с экспоненциальным бэкоффом (см. `backoff.ts`),
 * неповторяемые фиксируются как `failed` без повторов.
 */

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_ERROR_NAMES = new Set([
  "AbortError",
  "FetchError",
  "TimeoutError",
]);

/** Опции {@link ChannelDeliveryError}. */
export interface ChannelDeliveryErrorOptions {
  status?: number;
  code?: string;
  retryable?: boolean;
  category?: string;
  retryAfterMs?: number;
}

/**
 * Ошибка доставки во внешний канал. Несёт HTTP-статус внешнего API и/или
 * явный флаг повторяемости, чтобы движок доставки принял решение о ретрае.
 */
export class ChannelDeliveryError extends Error {
  // `declare`: поля объявляются только на уровне типов и присваиваются условно
  // в конструкторе — без эмита инициализаторов, чтобы не менять рантайм.
  declare readonly status?: number;
  declare readonly code?: string;
  declare readonly retryable?: boolean;
  declare readonly category?: string;
  declare readonly retryAfterMs?: number;

  constructor(
    message: string,
    { status, code, retryable, category, retryAfterMs }: ChannelDeliveryErrorOptions = {},
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
    this.status = status;
    this.code = code;
    if (typeof retryable === "boolean") {
      this.retryable = retryable;
    }
    if (typeof category === "string") {
      this.category = category;
    }
    if (Number.isFinite(retryAfterMs)) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/**
 * Классифицирует произвольную ошибку доставки.
 *
 * @param {unknown} error
 * @returns {{ retryable: boolean, category: string, status?: number,
 *   retryAfterMs?: number }}
 */
export function classifyDeliveryError(error) {
  const status = readStatus(error);
  const code = typeof error?.code === "string" ? error.code : undefined;
  const name = typeof error?.name === "string" ? error.name : undefined;
  const retryAfterMs = readRetryAfterMs(error);

  // Явный флаг повторяемости у ошибки имеет приоритет.
  if (typeof error?.retryable === "boolean") {
    return withRetryAfter(
      {
        retryable: error.retryable,
        category:
          typeof error.category === "string"
            ? error.category
            : error.retryable
              ? "explicit_retryable"
              : "explicit_permanent",
        status,
      },
      retryAfterMs,
    );
  }

  if (typeof status === "number") {
    if (status === 429) {
      return withRetryAfter(
        { retryable: true, category: "rate_limited", status },
        retryAfterMs,
      );
    }
    if (RETRYABLE_HTTP_STATUSES.has(status)) {
      return withRetryAfter(
        {
          retryable: true,
          category: status >= 500 ? "server_error" : "timeout",
          status,
        },
        retryAfterMs,
      );
    }
    if (status >= 400 && status < 500) {
      return { retryable: false, category: "client_error", status };
    }
    if (status >= 200 && status < 300) {
      return { retryable: false, category: "unexpected_success", status };
    }
  }

  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return withRetryAfter(
      { retryable: true, category: "network", status },
      retryAfterMs,
    );
  }

  if (name && RETRYABLE_ERROR_NAMES.has(name)) {
    return withRetryAfter(
      { retryable: true, category: "network", status },
      retryAfterMs,
    );
  }

  // По умолчанию неизвестные ошибки считаем неповторяемыми, чтобы не молотить
  // внешний API вслепую (ТЗ §10.8: осознанная оценка повторяемости).
  return { retryable: false, category: "unknown", status };
}

function withRetryAfter(classification, retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) {
    return { ...classification, retryAfterMs };
  }
  return classification;
}

function readStatus(error) {
  const candidate = error?.status ?? error?.statusCode ?? error?.response?.status;
  return Number.isInteger(candidate) ? candidate : undefined;
}

function readRetryAfterMs(error) {
  if (Number.isFinite(error?.retryAfterMs)) {
    return error.retryAfterMs;
  }
  if (Number.isFinite(error?.retryAfterSeconds)) {
    return error.retryAfterSeconds * 1000;
  }
  return undefined;
}
