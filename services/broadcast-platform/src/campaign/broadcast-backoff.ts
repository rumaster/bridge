/**
 * Экспоненциальный бэкофф для ретраев запуска кампании (ТЗ §14.9).
 *
 * При **временных** ошибках доставки через ядро (ядро/адаптер временно
 * недоступны) SVC-BCAST повторяет передачу того же C1-черновика. Повтор
 * безопасен: `idempotency_key = message_id` гарантирует дедупликацию в ядре —
 * без дублей (ТЗ §11.12). Расписание задержек детерминировано и ограничено:
 *   delay(n) = min(maxDelayMs, baseDelayMs * factor^(n-1))
 */

const DEFAULT_OPTIONS = Object.freeze({
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 10_000,
  maxAttempts: 4,
});

export function createBroadcastBackoff(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  assertPositiveNumber(config.baseDelayMs, "baseDelayMs");
  assertPositiveNumber(config.maxDelayMs, "maxDelayMs");
  if (!(config.factor >= 1)) {
    throw new TypeError("factor must be >= 1");
  }
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }
  if (config.maxDelayMs < config.baseDelayMs) {
    throw new TypeError("maxDelayMs must be >= baseDelayMs");
  }

  return {
    get maxAttempts() {
      return config.maxAttempts;
    },

    /** Пауза (мс) перед попыткой, следующей за завершившейся `attemptNo`. */
    delayForAttempt(attemptNo) {
      if (!Number.isInteger(attemptNo) || attemptNo < 1) {
        throw new TypeError("attemptNo must be a positive integer");
      }
      const exponential = config.baseDelayMs * config.factor ** (attemptNo - 1);
      return Math.min(config.maxDelayMs, Math.round(exponential));
    },

    /** Полное расписание задержек ретраев (для тестов/диагностики). */
    schedule() {
      const delays = [];
      for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) {
        delays.push(this.delayForAttempt(attempt));
      }
      return delays;
    },
  };
}

function assertPositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}
