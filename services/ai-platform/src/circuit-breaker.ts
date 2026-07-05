/**
 * Minimal circuit breaker for the SVC-AI LLM facade (ТЗ §11.2).
 *
 * A flapping or unreachable LLM provider must not pile up slow calls in the
 * facade. After `failureThreshold` consecutive failures the breaker OPENS and
 * short-circuits every further call for `cooldownMs`, so the assistant degrades
 * instantly to its stub instead of waiting on repeated timeouts. Once the
 * cooldown elapses the breaker moves to HALF_OPEN and lets a single trial call
 * through: on success it CLOSES, on failure it re-OPENS for another cooldown.
 *
 * The clock is injectable so the breaker is fully deterministic under test.
 */

export const BREAKER_STATES = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

/** The three states a {@link createCircuitBreaker} instance can report. */
export type BreakerState = "closed" | "open" | "half_open";

/** Immutable view of a breaker for `/health` and metrics gauges. */
export interface CircuitBreakerSnapshot {
  state: BreakerState;
  consecutive_failures: number;
}

/** Circuit breaker guarding the resilient LLM facade (ТЗ §11.2). */
export interface CircuitBreaker {
  readonly state: BreakerState;
  assertClosed(): void;
  recordSuccess(): void;
  recordFailure(): void;
  snapshot(): CircuitBreakerSnapshot;
}

/** Tunables accepted by {@link createCircuitBreaker}. */
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  onOpen?: () => void;
}

export class CircuitOpenError extends Error {
  readonly reason: string;

  constructor(reason: string = "circuit_open") {
    super(`LLM circuit breaker is open: ${reason}`);
    this.name = "CircuitOpenError";
    // Map to the C4 `fallback_reason` vocabulary: an open circuit is a form of
    // provider unavailability.
    this.reason = "unavailable";
  }
}

export function createCircuitBreaker({
  failureThreshold = 5,
  cooldownMs = 30_000,
  now = () => Date.now(),
  onOpen = () => {},
}: CircuitBreakerOptions = {}): CircuitBreaker {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new TypeError("failureThreshold must be a positive integer");
  }

  let state: BreakerState = BREAKER_STATES.CLOSED;
  let consecutiveFailures = 0;
  let openedAt = 0;

  // Resolve the *effective* state, promoting OPEN → HALF_OPEN once the cooldown
  // window has elapsed.
  function effectiveState() {
    if (state === BREAKER_STATES.OPEN && now() - openedAt >= cooldownMs) {
      state = BREAKER_STATES.HALF_OPEN;
    }
    return state;
  }

  return {
    get state() {
      return effectiveState();
    },

    /** Throw `CircuitOpenError` when the breaker currently forbids a call. */
    assertClosed() {
      if (effectiveState() === BREAKER_STATES.OPEN) {
        throw new CircuitOpenError();
      }
    },

    recordSuccess() {
      consecutiveFailures = 0;
      state = BREAKER_STATES.CLOSED;
    },

    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        if (state !== BREAKER_STATES.OPEN) {
          onOpen();
        }
        state = BREAKER_STATES.OPEN;
        openedAt = now();
      }
    },

    snapshot() {
      return {
        state: effectiveState(),
        consecutive_failures: consecutiveFailures,
      };
    },
  };
}
