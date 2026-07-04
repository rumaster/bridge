import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BREAKER_STATES,
  CircuitOpenError,
  createCircuitBreaker,
} from "../../src/circuit-breaker.mjs";

/**
 * The breaker's clock is injectable so every timing assertion is deterministic:
 * we drive `clock.value` by hand instead of waiting on real time (ТЗ §11.2).
 */
function fakeClock(start = 0) {
  const clock = { value: start };
  return {
    now: () => clock.value,
    advance(ms) {
      clock.value += ms;
    },
  };
}

describe("circuit breaker — states", () => {
  it("starts closed and allows calls", () => {
    const breaker = createCircuitBreaker();
    assert.equal(breaker.state, BREAKER_STATES.CLOSED);
    assert.doesNotThrow(() => breaker.assertClosed());
  });

  it("opens after the configured number of consecutive failures", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.CLOSED, "still closed below threshold");
    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.OPEN);
    assert.throws(() => breaker.assertClosed(), CircuitOpenError);
  });

  it("maps an open circuit to the C4 'unavailable' fallback reason", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    try {
      breaker.assertClosed();
      assert.fail("expected the open breaker to throw");
    } catch (error) {
      assert.ok(error instanceof CircuitOpenError);
      assert.equal(error.reason, "unavailable");
    }
  });

  it("resets the failure streak on success", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.CLOSED, "streak was reset by the success");
  });

  it("calls onOpen exactly once on the closed → open transition", () => {
    let opens = 0;
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      onOpen: () => {
        opens += 1;
      },
    });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(opens, 1, "onOpen fires on the transition, not on every failure");
  });
});

describe("circuit breaker — cooldown and half-open", () => {
  it("promotes open → half-open once the cooldown elapses", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.OPEN);

    clock.advance(999);
    assert.equal(breaker.state, BREAKER_STATES.OPEN, "still cooling down");

    clock.advance(1);
    assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);
    assert.doesNotThrow(() => breaker.assertClosed(), "a trial call is allowed");
  });

  it("closes on a successful half-open trial call", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    breaker.recordFailure();
    clock.advance(1000);
    assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);

    breaker.recordSuccess();
    assert.equal(breaker.state, BREAKER_STATES.CLOSED);
  });

  it("re-opens for another cooldown when the half-open trial fails", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    breaker.recordFailure();
    clock.advance(1000);
    assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);

    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.OPEN);
    clock.advance(999);
    assert.equal(breaker.state, BREAKER_STATES.OPEN, "the new cooldown restarted");
  });
});

describe("circuit breaker — guards", () => {
  it("rejects a non-positive failure threshold", () => {
    assert.throws(() => createCircuitBreaker({ failureThreshold: 0 }), TypeError);
    assert.throws(() => createCircuitBreaker({ failureThreshold: 1.5 }), TypeError);
  });

  it("exposes a snapshot with the effective state and failure count", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    const snapshot = breaker.snapshot();
    assert.equal(snapshot.state, BREAKER_STATES.CLOSED);
    assert.equal(snapshot.consecutive_failures, 1);
  });
});
