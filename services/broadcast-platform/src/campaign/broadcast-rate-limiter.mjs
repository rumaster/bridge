/**
 * Rate limiting кампаний на канал/организацию (ТЗ §14.6).
 *
 * SVC-BCAST не должен «залить» ядро и адаптеры массовой отправкой: перед
 * передачей каждого сообщения в ядро он берёт токен из ведра, изолированного
 * по ключу **канал+организация**. Исчерпание лимита одной пары не тормозит
 * доставку по другой (изоляция нагрузки, плана §8). При нехватке токенов
 * `acquire()` применяет backpressure — ждёт пополнения ведра.
 *
 * Лимит задаётся в сообщениях/минуту (политика C8 `rate_limit` или Capability C6,
 * см. `channel-capability.mjs`). Модель ведра — непрерывное пополнение; часы
 * (`now`) и пауза (`sleep`) инъектируются ради детерминированных тестов.
 */

const MINUTE_MS = 60_000;

export function createBroadcastRateLimiter({
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const buckets = new Map();
  const metrics = {
    acquired_total: 0,
    throttled_total: 0,
    backpressure_waits_total: 0,
    backpressure_wait_ms_total: 0,
  };

  function bucketFor(key, messagesPerMinute, burst) {
    let bucket = buckets.get(key);
    if (!bucket) {
      const capacity = Number.isFinite(burst) && burst > 0 ? burst : messagesPerMinute;
      bucket = {
        tokens: Number.isFinite(capacity) ? capacity : Number.POSITIVE_INFINITY,
        capacity,
        messagesPerMinute,
        updatedAt: now(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  function refill(bucket) {
    if (!Number.isFinite(bucket.messagesPerMinute)) {
      return; // Безлимитный канал (лимит не задан) — пополнять нечего.
    }
    const timestamp = now();
    const elapsed = timestamp - bucket.updatedAt;
    if (elapsed > 0) {
      const refilled = (elapsed / MINUTE_MS) * bucket.messagesPerMinute;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refilled);
      bucket.updatedAt = timestamp;
    }
  }

  function retryAfterMs(bucket) {
    const missing = 1 - bucket.tokens;
    return Math.ceil((missing / bucket.messagesPerMinute) * MINUTE_MS);
  }

  return {
    getMetrics() {
      return { ...metrics };
    },

    availableTokens(key) {
      const bucket = buckets.get(key);
      if (!bucket) {
        return Number.POSITIVE_INFINITY;
      }
      refill(bucket);
      return bucket.tokens;
    },

    /**
     * Блокирующее получение токена (backpressure): ждёт пополнения ведра, пока
     * токен не станет доступен. `maxWaitMs` ограничивает суммарное ожидание.
     *
     * @param {string} key Ключ ведра (обычно `${organization}:${channel}`).
     * @param {{ messagesPerMinute?: number, burst?: number, maxWaitMs?: number }} [options]
     * @returns {Promise<{ key: string, waitedMs: number }>}
     */
    async acquire(
      key,
      {
        messagesPerMinute = Number.POSITIVE_INFINITY,
        burst,
        maxWaitMs = Number.POSITIVE_INFINITY,
      } = {},
    ) {
      assertKey(key);
      const bucket = bucketFor(key, messagesPerMinute, burst);
      let waited = 0;

      for (;;) {
        refill(bucket);
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          metrics.acquired_total += 1;
          return { key, waitedMs: waited };
        }

        metrics.throttled_total += 1;
        const wait = retryAfterMs(bucket);
        if (waited + wait > maxWaitMs) {
          const error = new Error(`broadcast rate limit backpressure timeout for ${key}`);
          error.code = "RATE_LIMIT_BACKPRESSURE_TIMEOUT";
          error.key = key;
          error.retryAfterMs = wait;
          throw error;
        }

        metrics.backpressure_waits_total += 1;
        metrics.backpressure_wait_ms_total += wait;
        waited += wait;
        await sleep(wait);
      }
    },
  };
}

function assertKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("rate limiter key must be a non-empty string");
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
