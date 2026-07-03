import { createAiPlatformServer } from "./server.mjs";
import { createRagAssistant } from "./rag-assistant.mjs";
import { createDeterministicMockLlm } from "./llm.mjs";
import { createBackendKbSearch } from "./kb-search.mjs";

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
 */
function buildServerOptions() {
  const backendKbUrl = process.env.AI_BACKEND_KB_URL;
  if (!backendKbUrl) {
    return {};
  }

  const kbSearch = createBackendKbSearch({ baseUrl: backendKbUrl });
  const ai = createRagAssistant({
    llm: createDeterministicMockLlm(),
    kbSearch,
  });

  return { ai, mode: "rag" };
}
