import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeterministicMockLlm } from "../../src/llm.js";
import { createAiMetrics } from "../../src/metrics.js";
import {
  createLlmProviderRegistry,
  createLlmRouter,
  resolveProviderSelection,
} from "../../src/provider-registry.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

function buildRegistry() {
  return createLlmProviderRegistry({
    economy: ({ model }) =>
      createDeterministicMockLlm({
        name: "economy",
        model: model ?? "mock-economy",
        pricing: { default: 8 },
      }),
    premium: ({ model }) =>
      createDeterministicMockLlm({
        name: "premium",
        model: model ?? "mock-premium",
        pricing: { default: 40 },
      }),
  });
}

describe("provider registry", () => {
  it("registers named factories and reports membership", () => {
    const registry = buildRegistry();
    assert.deepEqual(registry.names().sort(), ["economy", "premium"]);
    assert.equal(registry.has("economy"), true);
    assert.equal(registry.has("unknown"), false);
  });

  it("creates a provider from its factory with the requested model", () => {
    const registry = buildRegistry();
    const provider = registry.create("premium", { model: "gpt-x" });
    assert.equal(provider.name, "premium");
    assert.equal(provider.model, "gpt-x");
  });

  it("throws for an unknown provider name", () => {
    const registry = buildRegistry();
    assert.throws(() => registry.create("nope"), /Unknown LLM provider/);
  });

  it("rejects a non-function factory", () => {
    assert.throws(
      () => createLlmProviderRegistry({ bad: {} }),
      /must be a factory function/,
    );
  });
});

describe("resolveProviderSelection — §12.9 selection by config", () => {
  const config = {
    default: { provider: "economy", model: "mock-economy" },
    organizations: {
      [ORG_A]: { provider: "premium", model: "mock-premium" },
      [ORG_B]: { provider: "premium" },
    },
  };

  it("uses the platform default when the organization has no override", () => {
    const selection = resolveProviderSelection(config, "org-without-override");
    assert.deepEqual(selection, { provider: "economy", model: "mock-economy" });
  });

  it("prefers the per-organization override over the default", () => {
    const selection = resolveProviderSelection(config, ORG_A);
    assert.deepEqual(selection, { provider: "premium", model: "mock-premium" });
  });

  it("falls back to the default model when the override omits it", () => {
    const selection = resolveProviderSelection(config, ORG_B);
    assert.deepEqual(selection, { provider: "premium", model: "mock-economy" });
  });

  it("throws loudly when no provider is configured at all", () => {
    assert.throws(() => resolveProviderSelection({}, ORG_A), /No LLM provider configured/);
  });
});

describe("LLM router", () => {
  const config = {
    default: { provider: "economy" },
    organizations: {
      [ORG_A]: { provider: "premium", model: "mock-premium" },
    },
  };

  it("resolves each organization to a resilient facade for its configured provider", () => {
    const router = createLlmRouter({ registry: buildRegistry(), config });

    const forA = router.resolve(ORG_A);
    const forDefault = router.resolve("org-other");

    assert.equal(forA.resilient, true);
    assert.equal(forA.name, "premium");
    assert.equal(forA.model, "mock-premium");
    assert.equal(forDefault.name, "economy");
  });

  it("memoizes one facade (one breaker) per provider+model", () => {
    const router = createLlmRouter({ registry: buildRegistry(), config });
    const first = router.resolve(ORG_A);
    const second = router.resolve(ORG_A);
    assert.equal(first, second, "same provider+model returns the same facade instance");
  });

  it("shares a single metrics sink across resolved providers", async () => {
    const metrics = createAiMetrics();
    const router = createLlmRouter({ registry: buildRegistry(), config, metrics });

    await router.resolve(ORG_A).embed("возврат");
    await router.resolve("org-other").embed("доставка");

    assert.equal(metrics.snapshot().llm_call_total, 2);
  });

  it("exposes breaker states per resolved provider+model", () => {
    const router = createLlmRouter({ registry: buildRegistry(), config });
    router.resolve(ORG_A);
    const states = router.breakerStates();
    assert.ok("premium::mock-premium" in states);
    assert.equal(states["premium::mock-premium"].state, "closed");
  });

  it("requires a registry", () => {
    assert.throws(() => createLlmRouter({ config }), TypeError);
  });
});
