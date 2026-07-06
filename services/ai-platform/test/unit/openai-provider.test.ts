import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KB_EMBEDDING_DIMENSIONS } from "../../../../packages/contracts/src/c3-kb.js";
import { createAzureOpenAiLlm } from "../../src/providers/azure-provider.js";
import { createOpenAiLlm } from "../../src/providers/openai-provider.js";

function vector() {
  return Array.from({ length: KB_EMBEDDING_DIMENSIONS }, (_, index) => index / 1000);
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

describe("OpenAI provider", () => {
  it("embeds through the OpenAI REST embeddings endpoint", async () => {
    const calls: any[] = [];
    const provider = createOpenAiLlm({
      apiKey: "sk-test",
      baseUrl: "https://openai.test/v1/",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ data: [{ embedding: vector() }] });
      },
    });

    const embedding = await provider.embed("возврат заказа");

    assert.equal(embedding.length, KB_EMBEDDING_DIMENSIONS);
    assert.equal(calls[0].url, "https://openai.test/v1/embeddings");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
    assert.equal(JSON.parse(calls[0].init.body).model, "text-embedding-3-small");
  });

  it("generates strict JSON answers through chat completions", async () => {
    const calls: any[] = [];
    const provider = createOpenAiLlm({
      apiKey: "sk-test",
      chatModel: "gpt-stage4",
      baseUrl: "https://openai.test/v1",
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "Оформите возврат по инструкции [1].",
                  confidence: 0.91,
                  citations: [{ index: 1, document_id: "doc-1", chunk_id: "chunk-1" }],
                }),
              },
            },
          ],
        });
      },
    });

    const result = await provider.generate({
      organizationId: "org-1",
      query: "Как оформить возврат?",
      chunks: [
        {
          document_id: "doc-1",
          chunk_id: "chunk-1",
          title: "Возврат",
          content: "Возврат оформляется по заявке.",
        },
      ],
    });

    assert.equal(calls[0].url, "https://openai.test/v1/chat/completions");
    assert.equal(calls[0].body.model, "gpt-stage4");
    assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
    assert.equal(result.text, "Оформите возврат по инструкции [1].");
    assert.equal(result.confidence, 0.91);
    assert.equal(result.citations[0].chunk_id, "chunk-1");
  });
});

describe("Azure OpenAI provider", () => {
  it("uses deployment URLs and api-key authentication", async () => {
    const calls: any[] = [];
    const provider = createAzureOpenAiLlm({
      apiKey: "azure-key",
      endpoint: "https://azure-openai.test/",
      chatDeployment: "chat-prod",
      embeddingDeployment: "embed-prod",
      apiVersion: "2024-10-21",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ data: [{ embedding: vector() }] });
      },
    });

    await provider.embed("доставка");

    assert.equal(
      calls[0].url,
      "https://azure-openai.test/openai/deployments/embed-prod/embeddings?api-version=2024-10-21",
    );
    assert.equal(calls[0].init.headers["api-key"], "azure-key");
    assert.equal(JSON.parse(calls[0].init.body).model, "embed-prod");
  });
});
