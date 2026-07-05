/**
 * Rate limiting на канал (ТЗ §10.9).
 *
 * Каждый канал получает **изолированный** token bucket: исчерпание лимита
 * одного канала (например, Telegram) не тормозит доставку в другой (Email).
 * Это выполняет требование «изоляция нагрузки между каналами». При исчерпании
 * токенов `acquire()` применяет **backpressure** — ждёт пополнения ведра,
 * а `tryAcquire()` сразу возвращает отказ с `retryAfterMs`.
 *
 * Модель ведра: непрерывное пополнение
 *   tokens += (elapsedMs / refillIntervalMs) * refillTokens  (не выше capacity)
 * Часы (`now`) и пауза (`sleep`) инъектируются ради детерминированных тестов.
 */

const DEFAULT_LIMIT = Object.freeze({
  capacity: 30,
  refillTokens: 30,
  refillIntervalMs: 1000,
});

export function createChannelRateLimiter({
  limits = {},
  defaultLimit = DEFAULT_LIMIT,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const normalizedDefault = normalizeLimit(defaultLimit, "defaultLimit");
  const channelLimits = new Map();
  for (const [channel, limit] of Object.entries(limits)) {
    channelLimits.set(channel, normalizeLimit(limit, `limits.${channel}`));
  }

  const buckets = new Map();
  const metrics = {
    acquired_total: 0,
    throttled_total: 0,
    backpressure_waits_total: 0,
    backpressure_wait_ms_total: 0,
  };

  function limitFor(channel) {
    return channelLimits.get(channel) ?? normalizedDefault;
  }

  function bucketFor(channel) {
    let bucket = buckets.get(channel);
    if (!bucket) {
      const limit = limitFor(channel);
      bucket = { tokens: limit.capacity, updatedAt: now(), limit };
      buckets.set(channel, bucket);
    }
    return bucket;
  }

  function refill(bucket) {
    const timestamp = now();
    const elapsed = timestamp - bucket.updatedAt;
    if (elapsed > 0) {
      const refilled =
        (elapsed / bucket.limit.refillIntervalMs) * bucket.limit.refillTokens;
      bucket.tokens = Math.min(bucket.limit.capacity, bucket.tokens + refilled);
      bucket.updatedAt = timestamp;
    }
  }

  function inspect(bucket) {
    if (bucket.tokens >= 1) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const missing = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(
      (missing / bucket.limit.refillTokens) * bucket.limit.refillIntervalMs,
    );
    return { allowed: false, retryAfterMs };
  }

  return {
    getMetrics() {
      return { ...metrics };
    },

    /** Не блокирующая попытка списать 1 токен канала. */
    tryAcquire(channel) {
      assertChannel(channel);
      const bucket = bucketFor(channel);
      refill(bucket);
      const state = inspect(bucket);
      if (state.allowed) {
        bucket.tokens -= 1;
        metrics.acquired_total += 1;
        return { allowed: true, channel, retryAfterMs: 0 };
      }
      metrics.throttled_total += 1;
      return { allowed: false, channel, retryAfterMs: state.retryAfterMs };
    },

    /**
     * Блокирующее получение токена канала (backpressure): ждёт пополнения ведра,
     * пока токен не станет доступен. `maxWaitMs` ограничивает суммарное ожидание.
     */
    async acquire(channel, { maxWaitMs = Number.POSITIVE_INFINITY } = {}) {
      assertChannel(channel);
      const bucket = bucketFor(channel);
      let waited = 0;

      for (;;) {
        refill(bucket);
        const state = inspect(bucket);
        if (state.allowed) {
          bucket.tokens -= 1;
          metrics.acquired_total += 1;
          return { channel, waitedMs: waited };
        }

        metrics.throttled_total += 1;
        const wait = state.retryAfterMs;
        if (waited + wait > maxWaitMs) {
          const error: Error & {
            code?: string;
            channel?: string;
            retryAfterMs?: number;
          } = new Error(`rate limit backpressure timeout for channel ${channel}`);
          error.code = "RATE_LIMIT_BACKPRESSURE_TIMEOUT";
          error.channel = channel;
          error.retryAfterMs = wait;
          throw error;
        }

        metrics.backpressure_waits_total += 1;
        metrics.backpressure_wait_ms_total += wait;
        waited += wait;
        await sleep(wait);
      }
    },

    /** Текущее число доступных токенов канала (для диагностики/тестов). */
    availableTokens(channel) {
      assertChannel(channel);
      const bucket = bucketFor(channel);
      refill(bucket);
      return bucket.tokens;
    },
  };
}

function normalizeLimit(limit, name) {
  if (!limit || typeof limit !== "object") {
    throw new TypeError(`${name} must be an object`);
  }

  const capacity = limit.capacity ?? limit.burst ?? limit.refillTokens;
  const refillTokens = limit.refillTokens ?? limit.ratePerInterval ?? capacity;
  const refillIntervalMs = limit.refillIntervalMs ?? 1000;

  assertPositive(capacity, `${name}.capacity`);
  assertPositive(refillTokens, `${name}.refillTokens`);
  assertPositive(refillIntervalMs, `${name}.refillIntervalMs`);

  return { capacity, refillTokens, refillIntervalMs };
}

function assertPositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

function assertChannel(channel) {
  if (typeof channel !== "string" || channel.trim() === "") {
    throw new TypeError("channel must be a non-empty string");
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
