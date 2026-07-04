import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAiMetrics, renderPrometheus } from "../../src/metrics.mjs";

describe("AI metrics collector", () => {
  it("exposes every counter at zero before any traffic", () => {
    const snapshot = createAiMetrics().snapshot();
    assert.equal(snapshot.assistant_suggest_total, 0);
    assert.equal(snapshot.llm_call_total, 0);
    assert.equal(snapshot.llm_cost_micros_total, 0);
    assert.equal(snapshot.kb_search_total, 0);
  });

  it("increments a known counter (default +1, custom amount)", () => {
    const metrics = createAiMetrics();
    metrics.inc("assistant_suggest_total");
    metrics.inc("llm_cost_micros_total", 42);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.assistant_suggest_total, 1);
    assert.equal(snapshot.llm_cost_micros_total, 42);
  });

  it("throws on an unknown metric name to catch typos early", () => {
    assert.throws(() => createAiMetrics().inc("does_not_exist"), /Unknown AI metric/);
  });

  it("accumulates latency sum and count, ignoring invalid samples", () => {
    const metrics = createAiMetrics();
    metrics.observeLatency(10);
    metrics.observeLatency(30);
    metrics.observeLatency(-5); // ignored
    metrics.observeLatency(Number.NaN); // ignored
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.llm_latency_ms_sum, 40);
    assert.equal(snapshot.llm_latency_ms_count, 2);
  });

  it("returns an independent snapshot (no live mutation)", () => {
    const metrics = createAiMetrics();
    const snapshot = metrics.snapshot();
    metrics.inc("assistant_suggest_total");
    assert.equal(snapshot.assistant_suggest_total, 0, "snapshot is a copy");
  });
});

describe("renderPrometheus", () => {
  it("prefixes series and emits HELP/TYPE for known keys", () => {
    const text = renderPrometheus({ assistant_suggest_total: 3 });
    assert.match(text, /# HELP ai_platform_assistant_suggest_total /);
    assert.match(text, /# TYPE ai_platform_assistant_suggest_total counter/);
    assert.match(text, /ai_platform_assistant_suggest_total 3/);
  });

  it("appends gauges verbatim after the counters", () => {
    const text = renderPrometheus(
      { llm_call_total: 1 },
      { llm_circuit_breaker_open: 1 },
    );
    assert.match(text, /# TYPE ai_platform_llm_circuit_breaker_open gauge/);
    assert.match(text, /ai_platform_llm_circuit_breaker_open 1/);
  });

  it("renders unknown snapshot keys as generic counters (M0 mock compatibility)", () => {
    const text = renderPrometheus({ suggestions_total: 5 });
    assert.match(text, /# TYPE ai_platform_suggestions_total counter/);
    assert.match(text, /ai_platform_suggestions_total 5/);
  });

  it("ends with a trailing newline", () => {
    assert.match(renderPrometheus({ llm_call_total: 0 }), /\n$/);
  });
});
