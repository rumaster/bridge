/**
 * Facade resilience primitives shared by external-service facades (ТЗ §11.2): a
 * timeout, a circuit breaker (closed/open/half-open), a bulkhead (bounded
 * concurrency + queue) and a bounded retry queue. The primitives are
 * framework-agnostic and deterministic — every time-dependent branch reads an
 * injectable `now` clock so unit tests can drive open/half-open/closed
 * transitions without real timers.
 */

export type ResilienceRejectionReason =
  | "no_client"
  | "timeout"
  | "circuit_open"
  | "bulkhead_full"
  | "retry_queue_full"
  | "error";

export type ResilienceOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; reason: ResilienceRejectionReason; error?: unknown };

export type CircuitState = "closed" | "open" | "half_open";

export class FacadeTimeoutError extends Error {
  constructor(message = "Facade call timed out.") {
    super(message);
    this.name = "FacadeTimeoutError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker open. */
  failureThreshold?: number;
  /** Successful trial calls (while half-open) required to close again. */
  successThreshold?: number;
  /** How long the breaker stays open before allowing trial calls. */
  resetTimeoutMs?: number;
  /** Concurrent trial calls permitted while half-open. */
  halfOpenMaxCalls?: number;
  /** Monotonic millisecond clock; injectable for deterministic tests. */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_RESET_TIMEOUT_MS = 10_000;
const DEFAULT_HALF_OPEN_MAX_CALLS = 1;

/**
 * A minimal circuit breaker. States:
 * - closed: calls flow; consecutive failures accumulate and trip it open;
 * - open: calls are rejected fast until `resetTimeoutMs` elapses;
 * - half_open: a bounded number of trial calls probe recovery — enough
 *   successes close it, any failure re-opens it.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.successThreshold = Math.max(1, options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD);
    this.resetTimeoutMs = Math.max(1, options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS);
    this.halfOpenMaxCalls = Math.max(1, options.halfOpenMaxCalls ?? DEFAULT_HALF_OPEN_MAX_CALLS);
    this.now = options.now ?? (() => Date.now());
  }

  /** Current state, after applying any pending open → half-open transition. */
  getState(): CircuitState {
    this.refresh();
    return this.state;
  }

  /**
   * Try to reserve a permit for one call. Returns whether the call may proceed;
   * every granted permit must later be settled with exactly one of
   * `onSuccess`, `onFailure` or `onCancel`.
   */
  tryAcquire(): { allowed: true } | { allowed: false; reason: "circuit_open" } {
    this.refresh();

    if (this.state === "closed") {
      return { allowed: true };
    }

    if (this.state === "half_open" && this.halfOpenInFlight < this.halfOpenMaxCalls) {
      this.halfOpenInFlight += 1;
      return { allowed: true };
    }

    return { allowed: false, reason: "circuit_open" };
  }

  onSuccess(): void {
    if (this.state === "half_open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this.close();
      }
      return;
    }

    this.failureCount = 0;
  }

  onFailure(): void {
    if (this.state === "half_open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.trip();
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.trip();
    }
  }

  /** Settle a permit that was reserved but never executed (e.g. bulkhead full). */
  onCancel(): void {
    if (this.state === "half_open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  private refresh(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half_open";
      this.successCount = 0;
      this.halfOpenInFlight = 0;
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenInFlight = 0;
  }

  private close(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenInFlight = 0;
  }
}

export interface BulkheadOptions {
  /** Maximum calls executing at once. */
  maxConcurrent?: number;
  /** Maximum calls waiting for a slot before new calls are rejected. */
  maxQueue?: number;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_QUEUE = 16;

/**
 * A bounded-concurrency gate. Up to `maxConcurrent` calls run simultaneously;
 * further calls wait in a queue of at most `maxQueue`; anything beyond that is
 * rejected immediately so an overloaded dependency cannot exhaust the core.
 */
export class Bulkhead {
  private active = 0;
  private readonly waiters: Array<(granted: true) => void> = [];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;

  constructor(options: BulkheadOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.maxQueue = Math.max(0, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  }

  /** Reserve a slot. Resolves `true` when granted, `false` when the gate is full. */
  acquire(): Promise<boolean> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(true);
    }

    if (this.waiters.length >= this.maxQueue) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Release a previously granted slot, handing it to the next waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(true);
      return;
    }

    this.active = Math.max(0, this.active - 1);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }
}

export interface FacadeResilienceOptions {
  circuitBreaker?: CircuitBreakerOptions;
  bulkhead?: BulkheadOptions;
  retry?: RetryQueueOptions;
  /** Default per-call timeout when a call does not override it. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;

export interface RetryQueueOptions {
  /** Total attempts, including the first call. */
  maxAttempts?: number;
  /** Maximum retry waiters admitted at once. */
  maxQueue?: number;
  /** Delay before every retry attempt. */
  delayMs?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_QUEUE = 16;
const DEFAULT_RETRY_DELAY_MS = 0;

export class RetryQueueFullError extends Error {
  constructor() {
    super("Retry queue is full.");
    this.name = "RetryQueueFullError";
  }
}

/**
 * Bounded retry helper for facade calls. A facade may retry transient failures,
 * but retries are capped so an unavailable dependency cannot build an
 * unbounded in-process backlog.
 */
export class RetryQueue {
  private queuedRetries = 0;
  private readonly maxAttempts: number;
  private readonly maxQueue: number;
  private readonly delayMs: number;

  constructor(options: RetryQueueOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS);
    this.maxQueue = Math.max(0, options.maxQueue ?? DEFAULT_RETRY_QUEUE);
    this.delayMs = Math.max(0, options.delayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  async execute<TValue>(call: () => Promise<TValue>): Promise<TValue> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts) {
          break;
        }

        await this.waitForRetrySlot();
      }
    }

    throw lastError;
  }

  get queuedCount(): number {
    return this.queuedRetries;
  }

  private async waitForRetrySlot(): Promise<void> {
    if (this.queuedRetries >= this.maxQueue) {
      throw new RetryQueueFullError();
    }

    this.queuedRetries += 1;
    try {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
    } finally {
      this.queuedRetries = Math.max(0, this.queuedRetries - 1);
    }
  }
}

/**
 * Composes a bulkhead, a circuit breaker and a timeout into a single guard for
 * an external dependency call. The order is: fail fast on an open breaker →
 * reserve a bulkhead slot → run the call under a timeout → record the verdict
 * back to the breaker. A missing `call` short-circuits to a `no_client`
 * outcome so facades can degrade when no upstream client is wired.
 */
export class FacadeResilience {
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;
  private readonly retryQueue: RetryQueue;
  private readonly defaultTimeoutMs: number;

  constructor(options: FacadeResilienceOptions = {}) {
    this.breaker = new CircuitBreaker(options.circuitBreaker);
    this.bulkhead = new Bulkhead(options.bulkhead);
    this.retryQueue = new RetryQueue(options.retry);
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  get circuitState(): CircuitState {
    return this.breaker.getState();
  }

  async execute<TValue>(
    call: (() => Promise<TValue>) | undefined,
    options: { timeoutMs?: number } = {},
  ): Promise<ResilienceOutcome<TValue>> {
    if (!call) {
      return { ok: false, reason: "no_client" };
    }

    const permit = this.breaker.tryAcquire();
    if (!permit.allowed) {
      return { ok: false, reason: "circuit_open" };
    }

    const granted = await this.bulkhead.acquire();
    if (!granted) {
      this.breaker.onCancel();
      return { ok: false, reason: "bulkhead_full" };
    }

    try {
      const value = await withTimeout(
        this.retryQueue.execute(call),
        options.timeoutMs ?? this.defaultTimeoutMs,
      );
      this.breaker.onSuccess();
      return { ok: true, value };
    } catch (error) {
      this.breaker.onFailure();
      return {
        ok: false,
        reason: rejectionReason(error),
        error,
      };
    } finally {
      this.bulkhead.release();
    }
  }
}

/** Reject with {@link FacadeTimeoutError} if `promise` outlives `timeoutMs`. */
export async function withTimeout<TValue>(
  promise: Promise<TValue>,
  timeoutMs: number,
): Promise<TValue> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new FacadeTimeoutError());
    }, Math.max(1, timeoutMs));
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function rejectionReason(error: unknown): Exclude<ResilienceRejectionReason, "no_client" | "circuit_open" | "bulkhead_full"> {
  if (error instanceof FacadeTimeoutError) {
    return "timeout";
  }

  if (error instanceof RetryQueueFullError) {
    return "retry_queue_full";
  }

  return "error";
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}
