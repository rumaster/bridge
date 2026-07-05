import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOpenAiLlm,
  OPENAI_DEFAULT_BASE_URL,
} from "../../src/providers/openai-provider.mjs";
import { LlmProviderError } from "../../src/providers/openai-compatible.mjs";
import { KB_EMBEDDING_DIMENSIONS } from "../../../../packages/contracts/src/c3-kb.mjs";
import {
  chatPayload,
  createMockFetch,
  embeddingPayload,
  jsonResponse,
  routeByPath,
} from "../helpers/mock-openai.mjs";

const ORG = "org-1";

function chunkFor(organizationId = ORG) {
  return {
    organization_id: organizationId,
    document_id: "doc-1",
    chunk_id: "c-1",
    title: "Возврат",
    content: "Возврат оформляется в течение 14 дней.",
    distance: 0.1,
  };
}

describe("createOpenAiLlm — embeddings", () => {
  it("POSTs to {baseUrl}/embeddings with a bearer token and returns the vector", async () => {
    const fetchImpl = createMockFetch(() =>
      embeddingPayload(KB_EMBEDDING_DIMENSIONS, 0.5),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const vector = await llm.embed("возврат заказа");

    assert.equal(vector.length, KB_EMBEDDING_DIMENSIONS);
    assert.equal(fetchImpl.calls.length, 1);
    const [call] = fetchImpl.calls;
    assert.equal(call.url, `${OPENAI_DEFAULT_BASE_URL}/embeddings`);
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "Bearer sk-test");
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.body.model, "text-embedding-3-small");
    assert.equal(call.body.input, "возврат заказа");
    // Never send `dimensions` — it would truncate models that are natively 1536.
    assert.equal("dimensions" in call.body, false);
  });

  it("rejects an embedding whose dimensionality does not match the Knowledge Base", async () => {
    const fetchImpl = createMockFetch(() => embeddingPayload(512));
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.embed("x"),
      (error) => {
        assert.ok(error instanceof LlmProviderError);
        assert.match(error.message, /512 dimensions, expected 1536/);
        return true;
      },
    );
  });

  it("throws when the embeddings response carries no vector", async () => {
    const fetchImpl = createMockFetch(() => ({ data: [] }));
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(() => llm.embed("x"), /missing data\[0\]\.embedding/);
  });
});

describe("createOpenAiLlm — generation", () => {
  it("generates a grounded answer in JSON mode and normalizes the result", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(
        JSON.stringify({
          text: "Оформите возврат в течение 14 дней [1].",
          confidence: 0.82,
          citations: [{ index: 1, document_id: "doc-1", chunk_id: "c-1" }],
        }),
      ),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const result = await llm.generate({
      query: "как вернуть заказ",
      chunks: [chunkFor()],
      organizationId: ORG,
    });

    assert.equal(result.text, "Оформите возврат в течение 14 дней [1].");
    assert.equal(result.confidence, 0.82);
    assert.deepEqual(result.citations, [
      { index: 1, document_id: "doc-1", chunk_id: "c-1" },
    ]);

    const [call] = fetchImpl.calls;
    assert.equal(call.url, `${OPENAI_DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(call.body.model, "gpt-4o-mini");
    assert.equal(call.body.temperature, 0.2);
    assert.deepEqual(call.body.response_format, { type: "json_object" });
    assert.equal(call.body.messages[0].role, "system");
    assert.equal(call.body.messages[1].role, "user");
    // The tenant boundary is expressed in the system prompt itself (ТЗ §22.6).
    assert.match(call.body.messages[0].content, new RegExp(ORG));
  });

  it("defaults confidence to 0.5 and citations to the context when the model omits them", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(JSON.stringify({ text: "Ответ по базе знаний [1]." })),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const result = await llm.generate({
      query: "вопрос",
      chunks: [chunkFor()],
      organizationId: ORG,
    });

    assert.equal(result.confidence, 0.5);
    assert.deepEqual(result.citations, [
      { index: 1, document_id: "doc-1", chunk_id: "c-1", title: "Возврат" },
    ]);
  });

  it("clamps an out-of-range confidence into [0, 1]", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(JSON.stringify({ text: "Ответ [1].", confidence: 4.2 })),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const result = await llm.generate({ query: "q", chunks: [], organizationId: ORG });
    assert.equal(result.confidence, 1);
  });

  it("wraps a non-JSON generation response in an LlmProviderError", async () => {
    const fetchImpl = createMockFetch(() => chatPayload("это не JSON"));
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.generate({ query: "q", chunks: [], organizationId: ORG }),
      /generation response was not valid JSON/,
    );
  });

  it("rejects a generation JSON without a non-empty text", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(JSON.stringify({ confidence: 0.9 })),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.generate({ query: "q", chunks: [], organizationId: ORG }),
      /missing a non-empty "text"/,
    );
  });

  it("throws when the chat completion is empty", async () => {
    const fetchImpl = createMockFetch(() => chatPayload(""));
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.generate({ query: "q", chunks: [], organizationId: ORG }),
      /empty content/,
    );
  });
});

describe("createOpenAiLlm — onboarding", () => {
  const actions = ["configuration.upsert", "noop"];

  it("interprets a request into a sanctioned command", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(
        JSON.stringify({
          action: "configuration.upsert",
          params: { key: "greeting", value: "Привет" },
          requiresConfirmation: true,
          notes: ["Обновит приветствие"],
        }),
      ),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const draft = await llm.interpretOnboarding({
      prompt: "Настрой приветствие",
      organizationId: ORG,
      actions,
    });

    assert.equal(draft.action, "configuration.upsert");
    assert.deepEqual(draft.params, { key: "greeting", value: "Привет" });
    assert.equal(draft.requiresConfirmation, true);
    assert.deepEqual(draft.notes, ["Обновит приветствие"]);

    const [call] = fetchImpl.calls;
    assert.deepEqual(call.body.response_format, { type: "json_object" });
    assert.match(call.body.messages[0].content, new RegExp(ORG));
  });

  it("coerces an off-catalogue action to noop", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(JSON.stringify({ action: "delete_all_tenants", params: {} })),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    const draft = await llm.interpretOnboarding({
      prompt: "удали всё",
      organizationId: ORG,
      actions,
    });

    assert.equal(draft.action, "noop");
    assert.equal(draft.requiresConfirmation, false);
    assert.match(draft.params.reason, /unsupported action/);
  });
});

describe("createOpenAiLlm — transport and configuration", () => {
  it("surfaces a non-2xx HTTP status as an LlmProviderError with the status", async () => {
    const fetchImpl = createMockFetch(() =>
      jsonResponse({ error: "rate limited" }, { ok: false, status: 429 }),
    );
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.embed("x"),
      (error) => {
        assert.ok(error instanceof LlmProviderError);
        assert.equal(error.status, 429);
        assert.match(error.message, /HTTP 429/);
        return true;
      },
    );
  });

  it("tags an AbortSignal.timeout rejection as a timeout degradation", async () => {
    const fetchImpl = async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    };
    const llm = createOpenAiLlm({ apiKey: "sk-test", fetchImpl });

    await assert.rejects(
      () => llm.embed("x"),
      (error) => {
        assert.ok(error instanceof LlmProviderError);
        assert.equal(error.reason, "timeout");
        return true;
      },
    );
  });

  it("requires an apiKey", () => {
    assert.throws(() => createOpenAiLlm({}), /requires an apiKey/);
  });

  it("honors a custom baseUrl and trims a trailing slash", async () => {
    const fetchImpl = createMockFetch(() => embeddingPayload());
    const llm = createOpenAiLlm({
      apiKey: "sk-test",
      baseUrl: "https://gateway.local/v1/",
      fetchImpl,
    });

    await llm.embed("x");
    assert.equal(fetchImpl.calls[0].url, "https://gateway.local/v1/embeddings");
  });

  it("sends the configured chat and embedding model names", async () => {
    const fetchImpl = routeByPath({
      embedding: embeddingPayload(),
      chat: chatPayload(JSON.stringify({ text: "ответ [1]" })),
    });
    const llm = createOpenAiLlm({
      apiKey: "sk-test",
      chatModel: "gpt-4o",
      embeddingModel: "text-embedding-3-large",
      fetchImpl,
    });

    await llm.embed("x");
    await llm.generate({ query: "q", chunks: [], organizationId: ORG });

    const embedCall = fetchImpl.calls.find((c) => c.url.endsWith("/embeddings"));
    const chatCall = fetchImpl.calls.find((c) => c.url.endsWith("/chat/completions"));
    assert.equal(embedCall.body.model, "text-embedding-3-large");
    assert.equal(chatCall.body.model, "gpt-4o");
  });
});
