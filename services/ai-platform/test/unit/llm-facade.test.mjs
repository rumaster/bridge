import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCircuitBreaker } from "../../src/circuit-breaker.mjs";
import {
  LlmTimeoutError,
  createResilientLlm,
  defaultCostModel,
} from "../../src/llm-facade.mjs";
import { createAiMetrics } from "../../src/metrics.mjs";
import { createDeterministicMockLlm } from "../../src/llm.mjs";

/**
 * A controllable provider: its capabilities resolve, reject or hang on demand so
 * the facade's timeout / circuit-breaker / metrics behaviour is fully
 * deterministic (no real network, no wall-clock waits beyond the tiny timeout).
 */
function stubProvider(overrides = {}) {
  return {
    name: "stub",
    model: "stub-1",
    dimensions: 8,
    pricing: { default: 10 },
    async embed(text) {
      return [text?.length ?? 0];
    },
    async generate() {
      return { text: "ok", confidence: 0.5, citations: [] };
    },
    async interpretOnboarding() {
      return { action: "noop", params: {} };
    },
    ...overrides,
  };
}

describe("resilient LLM facade — pass-through", () => {
  it("keeps the provider interface and marks itself resilient", () => {
    const facade = createResilientLlm({ provider: stubProvider() });
    assert.equal(facade.resilient, true);
    assert.equal(facade.name, "stub");
    assert.equal(facade.model, "stub-1");
    assert.equal(typeof facade.embed, "function");
    assert.equal(typeof facade.generate, "function");
    assert.equal(typeof facade.interpretOnboarding, "function");
  });

  it("only wraps capabilities the provider actually implements", () => {
    const facade = createResilientLlm({
      provider: { name: "embed-only", async embed() { return [1]; } },
    });
    assert.equal(typeof facade.embed, "function");
    assert.equal(facade.generate, undefined);
    assert.equal(facade.interpretOnboarding, undefined);
  });

  it("records call count, latency and cost on success", async () => {
    const metrics = createAiMetrics();
    const facade = createResilientLlm({ provider: stubProvider(), metrics });

    await facade.generate({ query: "возврат", chunks: [] });

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.llm_call_total, 1);
    assert.equal(snapshot.llm_call_failed_total, 0);
    assert.equal(snapshot.llm_latency_ms_count, 1);
    assert.ok(snapshot.llm_cost_micros_total >= 0);
  });
});

/**
 * A provider whose call hangs until it is torn down. The keepalive timer is
 * ref'd so the event loop stays alive long enough for the facade's own (unref'd,
 * production-correct) timeout to fire; `cleanup()` clears it so no timer leaks.
 */
function hangingProvider(capability) {
  const timers = [];
  const provider = stubProvider({
    [capability]: () =>
      new Promise((resolve) => {
        timers.push(setTimeout(resolve, 60_000));
      }),
  });
  provider.cleanup = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };
  return provider;
}

describe("resilient LLM facade — timeout", () => {
  it("aborts a hung provider call and counts a timeout", async () => {
    const metrics = createAiMetrics();
    const provider = hangingProvider("generate");
    const facade = createResilientLlm({ provider, metrics, timeoutMs: 20 });

    try {
      await assert.rejects(
        () => facade.generate({ query: "x", chunks: [] }),
        LlmTimeoutError,
      );
    } finally {
      provider.cleanup();
    }

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.llm_call_failed_total, 1);
    assert.equal(snapshot.llm_timeout_total, 1);
  });

  it("maps a timeout to the C4 'timeout' fallback reason", async () => {
    const provider = hangingProvider("embed");
    const facade = createResilientLlm({ provider, timeoutMs: 20 });
    try {
      await facade.embed("x");
      assert.fail("expected a timeout");
    } catch (error) {
      assert.ok(error instanceof LlmTimeoutError);
      assert.equal(error.reason, "timeout");
    } finally {
      provider.cleanup();
    }
  });
});

describe("resilient LLM facade — circuit breaker", () => {
  it("short-circuits once the breaker opens and stops calling the provider", async () => {
    const metrics = createAiMetrics();
    let calls = 0;
    const breaker = createCircuitBreaker({ failureThreshold: 2 });
    const facade = createResilientLlm({
      provider: stubProvider({
        async embed() {
          calls += 1;
          throw new Error("boom");
        },
      }),
      metrics,
      breaker,
    });

    await assert.rejects(() => facade.embed("a"));
    await assert.rejects(() => facade.embed("b"));
    // Breaker is open now — this call must be rejected without touching the provider.
    await assert.rejects(() => facade.embed("c"));

    assert.equal(calls, 2, "provider not called while the circuit is open");
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.llm_call_failed_total, 2);
    assert.equal(snapshot.llm_short_circuit_total, 1);
  });

  it("increments llm_circuit_open_total via its own breaker's onOpen", async () => {
    const metrics = createAiMetrics();
    const facade = createResilientLlm({
      provider: stubProvider({
        async embed() {
          throw new Error("boom");
        },
      }),
      metrics,
      // No breaker injected: the facade builds one wired to metrics.
    });

    // Default threshold is 5 consecutive failures.
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => facade.embed(`x${i}`));
    }
    assert.equal(metrics.snapshot().llm_circuit_open_total, 1);
    assert.equal(facade.getBreakerState().state, "open");
  });
});

describe("resilient LLM facade — cost model", () => {
  it("charges cheaper providers less for the same work", () => {
    const cheap = { pricing: { default: 8 } };
    const dear = { pricing: { default: 40 } };
    const args = [{ query: "a".repeat(1000), chunks: [] }];
    const result = { text: "" };

    const cheapCost = defaultCostModel("generate", args, result, cheap);
    const dearCost = defaultCostModel("generate", args, result, dear);
    assert.ok(dearCost > cheapCost, "premium pricing must cost more per call");
  });

  it("falls back to the default rate when a provider has no pricing", () => {
    const cost = defaultCostModel("embed", ["x".repeat(1000)], undefined, {});
    assert.ok(cost > 0);
  });
});

describe("resilient LLM facade — guards", () => {
  it("requires a provider object", () => {
    assert.throws(() => createResilientLlm({}), TypeError);
  });

  it("wraps the real deterministic mock without changing its output", async () => {
    const provider = createDeterministicMockLlm();
    const facade = createResilientLlm({ provider });
    const direct = await provider.embed("возврат заказа");
    const viaFacade = await facade.embed("возврат заказа");
    assert.deepEqual(viaFacade, direct);
  });
});
