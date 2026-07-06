export class ChannelTimeoutError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly category: string;

  constructor(message = "external channel delivery timed out") {
    super(message);
    this.name = "ChannelTimeoutError";
    this.code = "ETIMEDOUT";
    this.retryable = true;
    this.category = "timeout";
  }
}

export class CircuitOpenError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly category: string;

  constructor(message = "external channel circuit breaker is open") {
    super(message);
    this.name = "CircuitOpenError";
    this.code = "ECIRCUITOPEN";
    this.retryable = true;
    this.category = "circuit_open";
  }
}

export class BulkheadFullError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly category: string;

  constructor(message = "external channel bulkhead is full") {
    super(message);
    this.name = "BulkheadFullError";
    this.code = "EBULKHEADFULL";
    this.retryable = true;
    this.category = "bulkhead_full";
  }
}

export function createChannelResilience({
  timeoutMs = 2500,
  circuitBreaker = {},
  bulkhead = {},
  now = () => Date.now(),
} = {}) {
  const breaker = createCircuitBreaker({ ...circuitBreaker, now });
  const concurrency = createBulkhead(bulkhead);

  return {
    getSnapshot() {
      return {
        circuit: breaker.getState(),
        active: concurrency.activeCount,
        queued: concurrency.queuedCount,
      };
    },

    async execute(call) {
      const permit = breaker.tryAcquire();
      if (!permit.allowed) {
        return { ok: false, reason: "circuit_open", error: new CircuitOpenError() };
      }

      const granted = await concurrency.acquire();
      if (!granted) {
        breaker.onCancel();
        return { ok: false, reason: "bulkhead_full", error: new BulkheadFullError() };
      }

      const controller =
        typeof AbortController === "function" ? new AbortController() : undefined;

      try {
        const value = await withTimeout(
          call({ signal: controller?.signal }),
          timeoutMs,
          controller,
        );
        breaker.onSuccess();
        return { ok: true, value };
      } catch (error) {
        breaker.onFailure();
        return {
          ok: false,
          reason: error instanceof ChannelTimeoutError ? "timeout" : "error",
          error,
        };
      } finally {
        concurrency.release();
      }
    },
  };
}

export function createCircuitBreaker({
  failureThreshold = 5,
  successThreshold = 1,
  resetTimeoutMs = 10_000,
  halfOpenMaxCalls = 1,
  now = () => Date.now(),
} = {}) {
  let state = "closed";
  let failureCount = 0;
  let successCount = 0;
  let openedAt = 0;
  let halfOpenInFlight = 0;

  const normalizedFailureThreshold = Math.max(1, failureThreshold);
  const normalizedSuccessThreshold = Math.max(1, successThreshold);
  const normalizedResetTimeoutMs = Math.max(1, resetTimeoutMs);
  const normalizedHalfOpenMaxCalls = Math.max(1, halfOpenMaxCalls);

  function refresh() {
    if (state === "open" && now() - openedAt >= normalizedResetTimeoutMs) {
      state = "half_open";
      successCount = 0;
      halfOpenInFlight = 0;
    }
  }

  function trip() {
    state = "open";
    openedAt = now();
    failureCount = 0;
    successCount = 0;
    halfOpenInFlight = 0;
  }

  function close() {
    state = "closed";
    failureCount = 0;
    successCount = 0;
    halfOpenInFlight = 0;
  }

  return {
    getState() {
      refresh();
      return state;
    },

    tryAcquire() {
      refresh();

      if (state === "closed") {
        return { allowed: true };
      }

      if (
        state === "half_open" &&
        halfOpenInFlight < normalizedHalfOpenMaxCalls
      ) {
        halfOpenInFlight += 1;
        return { allowed: true };
      }

      return { allowed: false, reason: "circuit_open" };
    },

    onSuccess() {
      if (state === "half_open") {
        halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
        successCount += 1;
        if (successCount >= normalizedSuccessThreshold) {
          close();
        }
        return;
      }

      failureCount = 0;
    },

    onFailure() {
      if (state === "half_open") {
        halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
        trip();
        return;
      }

      failureCount += 1;
      if (failureCount >= normalizedFailureThreshold) {
        trip();
      }
    },

    onCancel() {
      if (state === "half_open") {
        halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
      }
    },
  };
}

export function createBulkhead({ maxConcurrent = 8, maxQueue = 16 } = {}) {
  let active = 0;
  const waiters = [];
  const normalizedMaxConcurrent = Math.max(1, maxConcurrent);
  const normalizedMaxQueue = Math.max(0, maxQueue);

  return {
    acquire() {
      if (active < normalizedMaxConcurrent) {
        active += 1;
        return Promise.resolve(true);
      }

      if (waiters.length >= normalizedMaxQueue) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },

    release() {
      const next = waiters.shift();
      if (next) {
        next(true);
        return;
      }

      active = Math.max(0, active - 1);
    },

    get activeCount() {
      return active;
    },

    get queuedCount() {
      return waiters.length;
    },
  };
}

export async function withTimeout(promise, timeoutMs, controller) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new ChannelTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
