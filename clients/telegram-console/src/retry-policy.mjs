const DEFAULT_BACKOFF = Object.freeze({
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 5_000,
  maxAttempts: 4,
});

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "TIMEOUT",
]);

export function createBackoffPolicy(options = {}) {
  const config = { ...DEFAULT_BACKOFF, ...options };

  assertNonNegativeNumber(config.baseDelayMs, "baseDelayMs");
  assertNonNegativeNumber(config.maxDelayMs, "maxDelayMs");
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

    delayForAttempt(attemptNo) {
      if (!Number.isInteger(attemptNo) || attemptNo < 1) {
        throw new TypeError("attemptNo must be a positive integer");
      }
      const exponential = config.baseDelayMs * config.factor ** (attemptNo - 1);
      return Math.min(config.maxDelayMs, Math.round(exponential));
    },

    schedule() {
      const delays = [];
      for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) {
        delays.push(this.delayForAttempt(attempt));
      }
      return delays;
    },
  };
}

export async function executeWithRetries({
  operation,
  backoff = createBackoffPolicy(),
  sleep = defaultSleep,
  isRetryable = isRetryableTransientError,
  retryAfterMs = retryAfterMsFromError,
  onRetry = () => {},
} = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }

  for (let attempt = 1; attempt <= backoff.maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (error) {
      if (!isRetryable(error) || attempt >= backoff.maxAttempts) {
        throw error;
      }

      const delayMs = retryAfterMs(error) ?? backoff.delayForAttempt(attempt);
      await onRetry({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("retry attempts exhausted");
}

export function isRetryableTransientError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (typeof error.retryable === "boolean") {
    return error.retryable;
  }

  const status = Number(error.status ?? error.statusCode ?? error.error_code);
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return true;
  }
  if (status >= 500 && status <= 599) {
    return true;
  }

  const code = String(error.code ?? "").toUpperCase();
  return TRANSIENT_ERROR_CODES.has(code) || /TIMEOUT/i.test(error.message ?? "");
}

export function retryAfterMsFromError(error) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const direct = toNonNegativeNumber(error.retryAfterMs);
  if (direct !== null) {
    return direct;
  }

  const seconds =
    error.parameters?.retry_after ??
    error.response?.parameters?.retry_after ??
    error.body?.parameters?.retry_after;
  const parsedSeconds = toNonNegativeNumber(seconds);
  return parsedSeconds === null ? null : parsedSeconds * 1_000;
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
}

function toNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
