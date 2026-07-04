/**
 * Экспоненциальный бэкофф для ретраев доставки (ТЗ §10.8).
 *
 * Расписание задержек детерминировано и ограничено:
 *   delay(n) = min(maxDelayMs, baseDelayMs * factor^(n-1))
 * где n — номер завершившейся попытки (1-based); значение — пауза перед
 * следующей попыткой. Опциональный джиттер вносит разброс, чтобы одновременно
 * упавшие доставки не били во внешний API синхронно; источник случайности
 * инъектируется (`random`) ради детерминированных тестов.
 */

const DEFAULT_OPTIONS = Object.freeze({
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  jitter: false,
});

export function createBackoffPolicy(options = {}) {
  const config = normalizeOptions(options);

  return {
    get maxAttempts() {
      return config.maxAttempts;
    },

    /**
     * Пауза (мс) перед попыткой, следующей за завершившейся `attemptNo`.
     * @param {number} attemptNo 1-based номер завершившейся попытки.
     * @param {{ retryAfterMs?: number }} [hint] Подсказка от внешнего API
     *   (например, заголовок Retry-After при 429), имеет приоритет над формулой.
     */
    delayForAttempt(attemptNo, hint = {}) {
      if (!Number.isInteger(attemptNo) || attemptNo < 1) {
        throw new TypeError("attemptNo must be a positive integer");
      }

      const exponential = config.baseDelayMs * config.factor ** (attemptNo - 1);
      let delay = Math.min(config.maxDelayMs, Math.round(exponential));

      if (Number.isFinite(hint?.retryAfterMs) && hint.retryAfterMs >= 0) {
        delay = Math.min(config.maxDelayMs, Math.max(delay, Math.round(hint.retryAfterMs)));
      }

      if (config.jitter) {
        // Полный джиттер в диапазоне [0, delay]: сглаживает синхронные ретраи.
        const factor = clamp01(config.random());
        delay = Math.round(delay * factor);
      }

      return delay;
    },

    /** Полное расписание задержек для всех ретраев (для тестов/диагностики). */
    schedule() {
      const delays = [];
      for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) {
        delays.push(this.delayForAttempt(attempt));
      }
      return delays;
    },
  };
}

function normalizeOptions(options) {
  const merged = { ...DEFAULT_OPTIONS, ...options };

  assertPositiveNumber(merged.baseDelayMs, "baseDelayMs");
  assertPositiveNumber(merged.maxDelayMs, "maxDelayMs");
  if (!(merged.factor >= 1)) {
    throw new TypeError("factor must be >= 1");
  }
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }
  if (merged.maxDelayMs < merged.baseDelayMs) {
    throw new TypeError("maxDelayMs must be >= baseDelayMs");
  }

  const random = typeof merged.random === "function" ? merged.random : Math.random;

  return { ...merged, random };
}

function assertPositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
