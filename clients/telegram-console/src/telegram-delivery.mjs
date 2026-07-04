import {
  createBackoffPolicy,
  defaultSleep,
  executeWithRetries,
  isRetryableTransientError,
  retryAfterMsFromError,
} from "./retry-policy.mjs";

export const TELEGRAM_CONSOLE_DEFAULT_DELIVERY_LIMITS = Object.freeze({
  globalIntervalMs: Math.ceil(1_000 / 30),
  perChatIntervalMs: 1_000,
  groupChatIntervalMs: 3_000,
});

const DEFAULT_TELEGRAM_BACKOFF = Object.freeze({
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 5_000,
  maxAttempts: 4,
});

export function createReliableTelegramApiAdapter({
  telegramApi,
  now = () => Date.now(),
  sleep = defaultSleep,
  limits = {},
  backoff = {},
} = {}) {
  assertTelegramApi(telegramApi);

  const limiter = createTelegramRateLimiter({ now, sleep, limits });
  const backoffPolicy =
    typeof backoff.delayForAttempt === "function"
      ? backoff
      : createBackoffPolicy({ ...DEFAULT_TELEGRAM_BACKOFF, ...backoff });
  const metrics = {
    queued_total: 0,
    sent_total: 0,
    failed_total: 0,
    retries_total: 0,
    retry_wait_ms_total: 0,
    rate_limit_wait_ms_total: 0,
  };
  let tail = Promise.resolve();

  return {
    sendMessage(payload) {
      return enqueue(() => dispatchWithRetries("sendMessage", payload));
    },

    answerCallbackQuery(payload) {
      return enqueue(() => dispatchWithRetries("answerCallbackQuery", payload));
    },

    getMetrics() {
      return {
        ...metrics,
        limiter: limiter.getMetrics(),
      };
    },

    drain() {
      return tail;
    },
  };

  function enqueue(operation) {
    metrics.queued_total += 1;
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  async function dispatchWithRetries(method, payload) {
    try {
      return await executeWithRetries({
        backoff: backoffPolicy,
        sleep,
        isRetryable: isRetryableTelegramError,
        retryAfterMs: retryAfterMsFromError,
        operation: async () => {
          const rateLimit = await limiter.acquire(method, payload);
          metrics.rate_limit_wait_ms_total += rateLimit.waitedMs;
          const result = await telegramApi[method](payload);
          metrics.sent_total += 1;
          return result;
        },
        onRetry: ({ delayMs }) => {
          metrics.retries_total += 1;
          metrics.retry_wait_ms_total += delayMs;
        },
      });
    } catch (error) {
      metrics.failed_total += 1;
      throw error;
    }
  }
}

export function createTelegramRateLimiter({
  now = () => Date.now(),
  sleep = defaultSleep,
  limits = {},
} = {}) {
  const config = { ...TELEGRAM_CONSOLE_DEFAULT_DELIVERY_LIMITS, ...limits };
  assertInterval(config.globalIntervalMs, "globalIntervalMs");
  assertInterval(config.perChatIntervalMs, "perChatIntervalMs");
  assertInterval(config.groupChatIntervalMs, "groupChatIntervalMs");

  const nextAllowedAtByScope = new Map();
  const metrics = {
    acquired_total: 0,
    throttled_total: 0,
    wait_ms_total: 0,
  };

  return {
    async acquire(method, payload = {}) {
      const scopes = scopesFor(method, payload, config);
      let waitedMs = 0;

      for (;;) {
        const timestamp = Number(now());
        const wait = Math.max(
          0,
          ...scopes.map((scope) => (nextAllowedAtByScope.get(scope.key) ?? timestamp) - timestamp),
        );
        if (wait === 0) {
          for (const scope of scopes) {
            nextAllowedAtByScope.set(scope.key, timestamp + scope.intervalMs);
          }
          metrics.acquired_total += 1;
          return { waitedMs, scopes: scopes.map((scope) => scope.key) };
        }

        metrics.throttled_total += 1;
        metrics.wait_ms_total += wait;
        waitedMs += wait;
        await sleep(wait);
      }
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

export function isRetryableTelegramError(error) {
  return isRetryableTransientError(error);
}

function scopesFor(method, payload, config) {
  if (method !== "sendMessage") {
    return [];
  }

  const scopes = [];
  if (config.globalIntervalMs > 0) {
    scopes.push({ key: "telegram:global", intervalMs: config.globalIntervalMs });
  }

  const chatId = payload?.chat_id;
  if (Number.isInteger(chatId)) {
    const intervalMs = chatId < 0 ? config.groupChatIntervalMs : config.perChatIntervalMs;
    if (intervalMs > 0) {
      scopes.push({ key: `telegram:chat:${chatId}`, intervalMs });
    }
  }

  return scopes;
}

function assertTelegramApi(telegramApi) {
  if (!telegramApi || typeof telegramApi.sendMessage !== "function") {
    throw new TypeError("telegramApi with sendMessage is required");
  }
  if (typeof telegramApi.answerCallbackQuery !== "function") {
    throw new TypeError("telegramApi with answerCallbackQuery is required");
  }
}

function assertInterval(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
}
