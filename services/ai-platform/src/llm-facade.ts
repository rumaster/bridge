import {
  createCircuitBreaker,
  CircuitOpenError,
  type CircuitBreaker,
} from "./circuit-breaker.js";
import { createAiMetrics, type AiMetrics } from "./metrics.js";
import type { LlmProvider } from "./llm.js";

/**
 * Resilient LLM facade (ТЗ §11.2, §12.9, §24.4).
 *
 * Wraps a swappable LLM provider (embed / generate / interpretOnboarding) with
 * the three things the M5 hardening requires around every model call:
 *   - a per-call **timeout**, so a hung provider can never block the request;
 *   - a **circuit breaker**, so repeated failures short-circuit to the stub
 *     instead of piling up timeouts;
 *   - **metrics** — call/failure/timeout counts, latency and a deterministic
 *     cost estimate — recorded into the shared observability sink (§24.4).
 *
 * The facade keeps the exact provider interface, so callers (RAG assistant,
 * onboarding commander) stay unaware of it. On timeout or an open circuit it
 * throws so the caller runs its own graceful-degradation path (ТЗ §5.4).
 */

const CAPABILITIES = Object.freeze(["embed", "generate", "interpretOnboarding", "complete"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MICROS_PER_1K_CHARS = 20;

/** Options accepted by {@link createResilientLlm}. */
export interface ResilientLlmOptions {
  provider?: LlmProvider;
  timeoutMs?: number;
  metrics?: AiMetrics;
  breaker?: CircuitBreaker;
  now?: () => number;
  costModel?: (capability: string, args: any[], result: any, provider: any) => number;
}

export class LlmTimeoutError extends Error {
  readonly reason: string;

  constructor(timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
    this.reason = "timeout";
  }
}

export function createResilientLlm({
  provider,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  metrics = createAiMetrics(),
  breaker,
  now = () => Date.now(),
  costModel = defaultCostModel,
}: ResilientLlmOptions = {}): LlmProvider {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("createResilientLlm requires a provider");
  }

  const circuit =
    breaker ??
    createCircuitBreaker({
      now,
      onOpen: () => metrics.inc("llm_circuit_open_total"),
    });

  const facade: LlmProvider = {
    name: provider.name ?? "unknown",
    model: provider.model ?? null,
    dimensions: provider.dimensions,
    // Mark the facade so it is never double-wrapped.
    resilient: true,
    getBreakerState() {
      return circuit.snapshot();
    },
  };

  for (const capability of CAPABILITIES) {
    if (typeof provider[capability] === "function") {
      facade[capability] = (...args) => call(capability, args);
    }
  }

  return facade;

  async function call(capability, args) {
    // Fail fast while the breaker is open — no provider call, no timer.
    try {
      circuit.assertClosed();
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        metrics.inc("llm_short_circuit_total");
      }
      throw error;
    }

    metrics.inc("llm_call_total");
    const start = now();

    try {
      const result = await withTimeout(
        () => provider[capability](...args),
        timeoutMs,
      );
      circuit.recordSuccess();
      metrics.observeLatency(elapsed(start, now));
      metrics.inc("llm_cost_micros_total", cost(costModel, capability, args, result, provider));
      return result;
    } catch (error) {
      circuit.recordFailure();
      metrics.observeLatency(elapsed(start, now));
      metrics.inc("llm_call_failed_total");
      if (error instanceof LlmTimeoutError) {
        metrics.inc("llm_timeout_total");
      }
      throw error;
    }
  }
}

function elapsed(start, now) {
  const delta = now() - start;
  return delta >= 0 ? delta : 0;
}

function cost(costModel, capability, args, result, provider) {
  try {
    const value = costModel(capability, args, result, provider);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  } catch {
    return 0;
  }
}

/**
 * Race a provider call against a timeout. The timer is always cleared so it can
 * never keep the event loop alive after the call settles.
 */
function withTimeout(run, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(run);
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(timeoutMs)), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Deterministic cost estimate in micro-units: proportional to the characters a
 * call moves through the provider, scaled by the provider's per-capability
 * pricing (ТЗ §12.9 — cheaper models cost less per call). No randomness, so the
 * cost counter is reproducible in tests.
 */
export function defaultCostModel(capability, args, result, provider) {
  const pricing = provider?.pricing ?? {};
  const rate = pricing[capability] ?? pricing.default ?? DEFAULT_MICROS_PER_1K_CHARS;
  const chars = estimateChars(capability, args, result);
  return (chars / 1000) * rate;
}

function estimateChars(capability, args = [], result) {
  const input = args[0] ?? {};
  let chars = 0;

  if (capability === "embed") {
    chars += textLength(typeof input === "string" ? input : input.text);
  } else if (capability === "generate") {
    chars += textLength(input.query);
    for (const chunk of input.chunks ?? []) {
      chars += textLength(chunk?.content);
    }
    chars += textLength(result?.text);
  } else if (capability === "interpretOnboarding") {
    chars += textLength(input.prompt);
  } else if (capability === "complete") {
    // Сырой вызов узла «LLM»: платим и за промпт, и за сгенерированный текст.
    chars += textLength(input.prompt);
    chars += textLength(result?.text);
  }

  return chars;
}

function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}
