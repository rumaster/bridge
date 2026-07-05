import { createAiPlatformServer } from "./server.mjs";
import { createRagAssistant } from "./rag-assistant.mjs";
import { createDeterministicMockLlm } from "./llm.mjs";
import { createBackendKbSearch } from "./kb-search.mjs";
import { createAiMetrics } from "./metrics.mjs";
import {
  createLlmProviderRegistry,
  createLlmRouter,
} from "./provider-registry.mjs";
import {
  buildLlmRuntime,
  buildRealProviderFactories,
  readTimeoutMs,
} from "./providers/env.mjs";

const port = Number.parseInt(process.env.PORT ?? "3006", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = createAiPlatformServer(buildServerOptions());

server.listen(port, host, () => {
  console.log(`ai-platform listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

/**
 * When a Backend Knowledge Base URL is configured we serve the RAG-backed C4
 * assistant (CP-3). Without it we keep the M0 deterministic mock so local runs
 * and the M0 contract smoke test behave identically.
 *
 * Provider selection (ТЗ §12.9):
 *   - `AI_LLM_CONFIG` (JSON) selects the provider/model per organization/platform;
 *     the registry offers the deterministic mocks plus any real provider
 *     (`openai`/`azure`) whose credentials are present.
 *   - otherwise, if `LLM_PROVIDER` names a real provider, a single (possibly
 *     composite) OpenAI/Azure provider is built from the environment.
 *   - otherwise a deterministic mock is used.
 * Either way every LLM call is wrapped in the resilient facade (timeout + circuit
 * breaker) and quality/cost metrics land in a shared sink (ТЗ §11.2, §24.4).
 */
function buildServerOptions() {
  const backendKbUrl = process.env.AI_BACKEND_KB_URL;
  if (!backendKbUrl) {
    return {};
  }

  const metrics = createAiMetrics();
  const kbSearch = createBackendKbSearch({ baseUrl: backendKbUrl });
  const routerConfig = parseLlmConfig(process.env.AI_LLM_CONFIG);

  const assistantOptions = { kbSearch, metrics };
  if (routerConfig) {
    const registry = createLlmProviderRegistry(buildProviderFactories());
    const router = createLlmRouter({
      registry,
      config: routerConfig,
      metrics,
      timeoutMs: readTimeoutMs(process.env),
    });
    assistantOptions.resolveLlm = (organizationId) => router.resolve(organizationId);
  } else {
    const runtime = buildLlmRuntime({ env: process.env, metrics });
    assistantOptions.llm = runtime ? runtime.llm : createDeterministicMockLlm();
  }

  return { ai: createRagAssistant(assistantOptions), mode: "rag" };
}

/**
 * Named provider factories for the registry (ТЗ §12.9). The deterministic mocks
 * are always available; real OpenAI/Azure factories are added from the environment
 * when their credentials are present, so AI_LLM_CONFIG can route an organization to
 * a real model without touching the pipeline. `pricing` feeds the facade cost
 * estimate so an "economy" model is measurably cheaper.
 */
function buildProviderFactories() {
  return {
    "deterministic-mock": ({ model }) =>
      createDeterministicMockLlm({ name: "deterministic-mock", model }),
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
    ...buildRealProviderFactories(process.env),
  };
}

function parseLlmConfig(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  try {
    const config = JSON.parse(raw);
    return config && typeof config === "object" ? config : null;
  } catch {
    console.warn("Ignoring invalid AI_LLM_CONFIG (expected JSON)");
    return null;
  }
}
