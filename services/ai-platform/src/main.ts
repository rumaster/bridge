import { createAiPlatformServer, type AiPlatformServerOptions } from "./server.js";
import { createRagAssistant, type RagAssistantOptions } from "./rag-assistant.js";
import { createDeterministicAiMock } from "./deterministic-ai.js";
import { startAiPlatformGrpcServer } from "./grpc-server.js";
import { createDeterministicMockLlm } from "./llm.js";
import { createBackendKbSearch } from "./kb-search.js";
import { createAiMetrics } from "./metrics.js";
import {
  createLlmProviderRegistry,
  createLlmRouter,
} from "./provider-registry.js";
import {
  buildLlmRuntime,
  buildRealProviderFactories,
  readTimeoutMs,
} from "./providers/env.js";

const port = Number.parseInt(process.env.PORT ?? "3006", 10);
const host = process.env.HOST ?? "0.0.0.0";
const grpcPort = parseOptionalPort(process.env.AI_GRPC_PORT);
const grpcHost = process.env.AI_GRPC_HOST ?? host;

const serverOptions = buildServerOptions();
const server = createAiPlatformServer(serverOptions);
const grpcHandle = grpcPort
  ? await startAiPlatformGrpcServer({
      ai: serverOptions.ai ?? createDeterministicAiMock(),
      host: grpcHost,
      port: grpcPort,
    })
  : null;

server.listen(port, host, () => {
  console.log(`ai-platform listening on http://${host}:${port}`);
});

if (grpcHandle) {
  console.log(`ai-platform gRPC listening on ${grpcHandle.address}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}

/**
 * When a Backend Knowledge Base URL is configured we serve the RAG-backed C4
 * assistant (CP-3). Without it we keep the M0 deterministic mock so local runs
 * and the M0 contract smoke test behave identically.
 *
 * `AI_LLM_CONFIG` optionally selects a provider/model per organization/platform;
 * the registry offers deterministic local providers plus real OpenAI/Azure
 * factories when credentials are present. Without the JSON router, `LLM_PROVIDER`
 * can select one real provider. When neither is configured, CI/local runs keep
 * the deterministic provider behind the same public C4 `generated` attribution.
 */
function buildServerOptions(): AiPlatformServerOptions {
  const backendKbUrl = process.env.AI_BACKEND_KB_URL;
  if (!backendKbUrl) {
    return {};
  }

  const metrics = createAiMetrics();
  const kbSearch = createBackendKbSearch({ baseUrl: backendKbUrl });
  const routerConfig = parseLlmConfig(process.env.AI_LLM_CONFIG);

  const assistantOptions: RagAssistantOptions = { kbSearch, metrics };
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
 * Named provider factories for the registry (ТЗ §12.9). Deterministic local
 * providers are always available; real OpenAI/Azure factories are added from env
 * when credentials are present.
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

function parseOptionalPort(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function shutdown() {
  await Promise.all([closeHttpServer(), closeGrpcServer()]);
}

function closeHttpServer() {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose(undefined));
  });
}

function closeGrpcServer() {
  if (!grpcHandle) {
    return Promise.resolve();
  }

  return new Promise((resolveClose) => {
    grpcHandle.server.tryShutdown(() => resolveClose(undefined));
  });
}
