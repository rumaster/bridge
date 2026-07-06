import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KB_EMBEDDING_DIMENSIONS } from "../../packages/contracts/src/c3-kb.js";
import { createOpenAiLlm } from "../../services/ai-platform/src/providers/openai-provider.js";
import { createInMemoryKbSearch } from "../../services/ai-platform/src/kb-search.js";
import { createDeterministicMockLlm } from "../../services/ai-platform/src/llm.js";
import { createRagAssistant } from "../../services/ai-platform/src/rag-assistant.js";
import { startAiPlatformGrpcServer } from "../../services/ai-platform/src/grpc-server.js";
import { AiGrpcUpstreamClient } from "../../services/backend/src/modules/ai-integration/ai-grpc-upstream.client.js";

const ORG_ID = "org-stage-4";

function vector() {
  return Array.from({ length: KB_EMBEDDING_DIMENSIONS }, (_, index) => index / 1000);
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

describe("Stage 4 MP-07/MP-01 SVC-AI LLM over gRPC", () => {
  it("returns a generated C4 response from an OpenAI-compatible provider over the internal gRPC facade", async () => {
    const fetchCalls: string[] = [];
    const llm = createOpenAiLlm({
      apiKey: "sk-stage4",
      baseUrl: "https://openai.stage4.test/v1",
      chatModel: "gpt-stage4",
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        if (String(url).endsWith("/embeddings")) {
          return jsonResponse({ data: [{ embedding: vector() }] });
        }
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "Оформите возврат по регламенту [1].",
                  confidence: 0.88,
                  citations: [{ index: 1, document_id: "doc-return", chunk_id: "chunk-return" }],
                }),
              },
            },
          ],
        });
      },
    });

    const kb = createInMemoryKbSearch({
      llm: createDeterministicMockLlm(),
      chunks: [
        {
          organization_id: ORG_ID,
          document_id: "doc-return",
          chunk_id: "chunk-return",
          chunk_no: 1,
          title: "Возврат",
          content: "Возврат оформляется по регламенту поддержки.",
        },
      ],
    });
    await kb.ensureEmbeddings();

    const handle = await startAiPlatformGrpcServer({
      ai: createRagAssistant({
        llm,
        kbSearch: kb,
        now: () => "2026-07-06T13:30:00.000Z",
      }),
      host: "127.0.0.1",
      port: 0,
    });
    const client = new AiGrpcUpstreamClient({ target: `127.0.0.1:${handle.port}` });

    try {
      const response = await client.suggestAssistant({
        organization_id: ORG_ID,
        query: "Как оформить возврат?",
        request_id: "req-stage-4",
      });

      assert.equal(response.contract, "C4.AssistantSuggestResponse");
      assert.equal(response.degraded, false);
      assert.equal(response.suggestion.mode, "generated");
      assert.equal(response.suggestion.text, "Оформите возврат по регламенту [1].");
      assert.equal((response.sources[0] as any).chunk_id, "chunk-return");
      assert.ok(fetchCalls.some((url) => url.endsWith("/embeddings")));
      assert.ok(fetchCalls.some((url) => url.endsWith("/chat/completions")));
    } finally {
      client.onModuleDestroy();
      await new Promise<void>((resolveShutdown) => {
        handle.server.tryShutdown(() => resolveShutdown());
      });
    }
  });
});
