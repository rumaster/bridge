import {
  createCircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerSnapshot,
} from "./circuit-breaker.js";
import { createResilientLlm } from "./llm-facade.js";
import { createAiMetrics, type AiMetrics } from "./metrics.js";
import type { LlmProvider } from "./llm.js";

/**
 * LLM provider selection by configuration (ТЗ §12.9).
 *
 * When more than one provider/model is wired in, the choice is driven by
 * configuration — per organization first, then a platform default — never by
 * anything the model itself returns. The registry holds named provider factories
 * (each takes a `model` and returns a swappable LLM provider); the router
 * resolves a request's `organization_id` to a concrete provider+model, wraps it
 * in the resilient facade (timeout + circuit breaker + metrics) and memoizes one
 * facade per provider+model so a provider's breaker state and metrics persist
 * across requests.
 *
 * Selection is deterministic and tenant-agnostic in the sense that isolation is
 * unaffected: a provider choice only changes *which* model answers, never *whose*
 * data it may see — that boundary stays with the KB search and prompt (ТЗ §22.6).
 */

/** A concrete provider+model choice resolved from platform config (ТЗ §12.9). */
export interface ProviderSelection {
  provider?: string;
  model?: string | null;
}

/** Platform LLM selection config: per-organization overrides plus a default. */
export interface LlmSelectionConfig {
  default?: ProviderSelection;
  organizations?: Record<string, ProviderSelection>;
}

/** Named registry of LLM provider factories. */
export interface LlmProviderRegistry {
  has(name: string): boolean;
  names(): string[];
  create(name: string, options?: { model?: string | null }): LlmProvider;
}

/** Options accepted by {@link createLlmRouter}. */
export interface LlmRouterOptions {
  registry?: LlmProviderRegistry;
  config?: LlmSelectionConfig;
  metrics?: AiMetrics;
  timeoutMs?: number;
  breakerOptions?: CircuitBreakerOptions;
  now?: () => number;
}

export function createLlmProviderRegistry(providers = {}): LlmProviderRegistry {
  const factories = new Map();
  for (const [name, factory] of Object.entries(providers)) {
    if (typeof factory !== "function") {
      throw new TypeError(`Provider "${name}" must be a factory function`);
    }
    factories.set(name, factory);
  }

  return {
    has(name) {
      return factories.has(name);
    },
    names() {
      return [...factories.keys()];
    },
    create(name, options = {}) {
      const factory = factories.get(name);
      if (!factory) {
        throw new Error(`Unknown LLM provider: ${name}`);
      }
      return factory(options);
    },
  };
}

/**
 * Resolve the provider+model for one organization from a platform config. The
 * organization override wins; otherwise the platform default applies. Throws if
 * neither yields a known provider so a misconfiguration fails loudly at startup
 * rather than silently degrading every request.
 */
export function resolveProviderSelection(
  config: LlmSelectionConfig = {},
  organizationId?: string,
) {
  const organizations: Record<string, ProviderSelection> = config.organizations ?? {};
  const override = organizationId != null ? organizations[organizationId] : undefined;
  const fallback: ProviderSelection = config.default ?? {};

  const provider = override?.provider ?? fallback.provider;
  if (typeof provider !== "string" || provider === "") {
    throw new Error(
      `No LLM provider configured for organization ${organizationId ?? "<none>"}`,
    );
  }

  return {
    provider,
    model: override?.model ?? fallback.model ?? null,
  };
}

export function createLlmRouter({
  registry,
  config = {},
  metrics = createAiMetrics(),
  timeoutMs,
  breakerOptions,
  now = () => Date.now(),
}: LlmRouterOptions = {}) {
  if (!registry || typeof registry.create !== "function") {
    throw new TypeError("createLlmRouter requires a provider registry");
  }

  // One resilient facade (and therefore one breaker) per provider+model.
  const facades = new Map();

  function facadeFor(provider, model) {
    const key = `${provider}::${model ?? "default"}`;
    let facade = facades.get(key);
    if (!facade) {
      const instance = registry.create(provider, { model });
      facade = createResilientLlm({
        provider: instance,
        metrics,
        timeoutMs,
        breaker: breakerOptions
          ? createCircuitBreaker({
              ...breakerOptions,
              now,
              onOpen: () => metrics.inc("llm_circuit_open_total"),
            })
          : undefined,
        now,
      });
      facades.set(key, facade);
    }
    return facade;
  }

  return {
    selection(organizationId) {
      return resolveProviderSelection(config, organizationId);
    },

    resolve(organizationId) {
      const { provider, model } = resolveProviderSelection(config, organizationId);
      return facadeFor(provider, model);
    },

    breakerStates(): Record<string, CircuitBreakerSnapshot> {
      const states: Record<string, CircuitBreakerSnapshot> = {};
      for (const [key, facade] of facades.entries()) {
        states[key] = facade.getBreakerState();
      }
      return states;
    },
  };
}
