import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createAiPlatformServer } from "../../src/server.js";
import { createRagAssistant } from "../../src/rag-assistant.js";
import { createDeterministicMockLlm, createUnavailableLlm } from "../../src/llm.js";
import { createInMemoryKbSearch } from "../../src/kb-search.js";

const JSON_HEADERS = { "content-type": "application/json" };
const NOW = "2026-07-03T10:00:00.000Z";

const KB_CHUNKS = [
  {
    organization_id: "org-1",
    document_id: "doc-return",
    chunk_id: "chunk-return",
    chunk_no: 1,
    title: "Политика возврата",
    content: "Для возврата заказа уточните номер заказа и причину возврата.",
  },
  {
    organization_id: "org-1",
    document_id: "doc-delivery",
    chunk_id: "chunk-delivery",
    chunk_no: 1,
    title: "Доставка",
    content: "Доставка заказа занимает один рабочий день по городу.",
  },
  {
    organization_id: "org-2",
    document_id: "doc-secret",
    chunk_id: "chunk-secret",
    chunk_no: 1,
    title: "Возврат другой организации",
    content: "Секретная политика возврата заказа организации org-2.",
  },
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function suggest(baseUrl, organizationId, query) {
  return fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: `req-${organizationId}`,
      organization_id: organizationId,
      query,
    }),
  });
}

describe("RAG assistant server (mock LLM + in-memory KB)", () => {
  const llm = createDeterministicMockLlm();
  const kbSearch = createInMemoryKbSearch({ chunks: KB_CHUNKS, llm });
  let server;
  let baseUrl;

  before(async () => {
    server = createAiPlatformServer({
      ai: createRagAssistant({ llm, kbSearch, now: () => NOW }),
      mode: "rag",
      now: () => NOW,
    });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("reports the rag mode on health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(body.mode, "rag");
  });

  it("answers from the Knowledge Base with ranked source citations", async () => {
    const response = await suggest(baseUrl, "org-1", "Как оформить возврат заказа?");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.contract, "C4.AssistantSuggestResponse");
    assert.equal(body.degraded, false);
    assert.equal(body.suggestion.mode, "deterministic_mock");
    assert.equal(body.source_status, "available");

    const sourceIds = body.sources.map((source) => source.chunk_id);
    assert.deepEqual(sourceIds, ["chunk-return", "chunk-delivery"]);
    assert.equal(body.sources[0].source_type, "knowledge_chunk");
    assert.match(body.suggestion.text, /\[1\]/);
  });

  it("never returns another organization's chunk (tenant isolation)", async () => {
    const response = await suggest(baseUrl, "org-1", "возврат заказа");
    const body = await response.json();
    const ids = body.sources.map((source) => source.chunk_id);
    assert.ok(!ids.includes("chunk-secret"));
  });

  it("returns a 'none' source when the organization has no matching KB", async () => {
    const response = await suggest(baseUrl, "org-3", "возврат заказа");
    const body = await response.json();
    assert.equal(body.source_status, "available");
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].source_type, "none");
  });

  it("still validates malformed C4 requests", async () => {
    const response = await fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C4.AssistantSuggestRequest",
        version: "1.0.0",
        request_id: "req-bad",
        query: "",
      }),
    });
    assert.equal(response.status, 400);
  });
});

describe("RAG assistant degradation (LLM unavailable)", () => {
  let server;
  let baseUrl;

  before(async () => {
    const kbSearch = createInMemoryKbSearch({ chunks: KB_CHUNKS });
    server = createAiPlatformServer({
      ai: createRagAssistant({
        llm: createUnavailableLlm({ reason: "unavailable" }),
        kbSearch,
        now: () => NOW,
      }),
      mode: "rag",
      now: () => NOW,
    });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("degrades to a valid fallback response instead of failing", async () => {
    const response = await suggest(baseUrl, "org-1", "Как оформить возврат заказа?");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.contract, "C4.AssistantSuggestResponse");
    assert.equal(body.degraded, true);
    assert.equal(body.suggestion.mode, "fallback");
    assert.equal(body.source_status, "unavailable");
    assert.equal(body.fallback_reason, "unavailable");
    assert.deepEqual(body.sources, []);
  });

  it("counts degraded suggestions in metrics", async () => {
    await suggest(baseUrl, "org-1", "возврат");
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /ai_platform_assistant_suggest_degraded_total [1-9]/);
  });
});
