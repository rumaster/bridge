/**
 * SVC-AI observability sink (ТЗ §24.4, мастер-план §7.2).
 *
 * A single collector accumulates the quality/cost signals the M5 hardening asks
 * for — request counts, degradation ratio, Knowledge Base usage, LLM latency and
 * a deterministic cost estimate — and renders them as Prometheus text for the
 * `/metrics` endpoint. The collector performs no timing and no I/O of its own:
 * callers hand in already-measured durations and costs, so it stays pure and
 * trivially unit-testable.
 */

const COUNTER_KEYS = Object.freeze([
  "assistant_suggest_total",
  "assistant_suggest_degraded_total",
  "onboarding_command_total",
  "onboarding_command_degraded_total",
  "onboarding_command_rejected_total",
  "kb_search_total",
  "kb_search_failed_total",
  "llm_call_total",
  "llm_call_failed_total",
  "llm_timeout_total",
  "llm_short_circuit_total",
  "llm_circuit_open_total",
  "llm_cost_micros_total",
  "llm_latency_ms_sum",
  "llm_latency_ms_count",
]);

const METRIC_HELP = Object.freeze({
  assistant_suggest_total: "C4 assistant suggestions served.",
  assistant_suggest_degraded_total:
    "C4 assistant suggestions that fell back to the degraded stub.",
  onboarding_command_total: "C4 onboarding commands served.",
  onboarding_command_degraded_total:
    "C4 onboarding commands that degraded to a safe noop.",
  onboarding_command_rejected_total:
    "C4 onboarding drafts rejected by an SVC-AI safety barrier.",
  kb_search_total: "Knowledge Base searches issued to Backend (C3.kb).",
  kb_search_failed_total: "Knowledge Base searches that failed.",
  llm_call_total: "LLM provider calls attempted through the resilient facade.",
  llm_call_failed_total: "LLM provider calls that errored or timed out.",
  llm_timeout_total: "LLM provider calls aborted by the facade timeout.",
  llm_short_circuit_total:
    "LLM calls rejected immediately by an open circuit breaker.",
  llm_circuit_open_total: "Times the LLM circuit breaker transitioned to open.",
  llm_cost_micros_total: "Estimated cumulative LLM cost in micro-units.",
  llm_latency_ms_sum: "Cumulative LLM provider call latency in milliseconds.",
  llm_latency_ms_count: "Number of LLM provider calls measured for latency.",
});

const METRIC_TYPE = Object.freeze({
  llm_latency_ms_sum: "gauge",
  llm_latency_ms_count: "counter",
});

const METRIC_PREFIX = "ai_platform_";

/**
 * Create a fresh metrics collector. Every counter starts at zero so `snapshot()`
 * always exposes the full set of series, even before any traffic.
 */
export function createAiMetrics() {
  const state = {};
  for (const key of COUNTER_KEYS) {
    state[key] = 0;
  }

  return {
    /** Increment a named counter (defaults to +1). Unknown names throw early. */
    inc(name, amount = 1) {
      if (!(name in state)) {
        throw new Error(`Unknown AI metric: ${name}`);
      }
      state[name] += amount;
    },

    /** Record one LLM call latency measurement (sum + count). */
    observeLatency(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        return;
      }
      state.llm_latency_ms_sum += ms;
      state.llm_latency_ms_count += 1;
    },

    snapshot() {
      return { ...state };
    },
  };
}

/**
 * Render a metrics snapshot as Prometheus exposition text. Works for any
 * snapshot object (including the M0 deterministic mock's smaller one): known
 * keys get a documented HELP/TYPE, unknown keys fall back to a generic counter.
 * Optional `gauges` (e.g. circuit-breaker state) are appended verbatim.
 */
export function renderPrometheus(snapshot = {}, gauges = {}) {
  const lines = [];

  for (const [key, value] of Object.entries(snapshot)) {
    const metric = `${METRIC_PREFIX}${key}`;
    const help = METRIC_HELP[key] ?? `AI Platform metric ${key}.`;
    const type = METRIC_TYPE[key] ?? "counter";
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} ${type}`);
    lines.push(`${metric} ${value}`);
  }

  for (const [key, value] of Object.entries(gauges)) {
    const metric = `${METRIC_PREFIX}${key}`;
    lines.push(`# HELP ${metric} AI Platform gauge ${key}.`);
    lines.push(`# TYPE ${metric} gauge`);
    lines.push(`${metric} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}
