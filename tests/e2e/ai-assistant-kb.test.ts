import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  createKnowledgeSearchResponse,
  validateKnowledgeSearchRequest,
} from "../../packages/contracts/src/c3-kb.js";
import { createAiPlatformServer } from "../../services/ai-platform/src/server.js";
import { createRagAssistant } from "../../services/ai-platform/src/rag-assistant.js";
import { createDeterministicMockLlm } from "../../services/ai-platform/src/llm.js";
import {
  createBackendKbSearch,
  createInMemoryKbSearch,
} from "../../services/ai-platform/src/kb-search.js";

const JSON_HEADERS = { "content-type": "application/json" };
const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b1";

const KB_CHUNKS = [
  {
    organization_id: ORG_A,
    document_id: "doc-a-return",
    chunk_id: "chunk-a-return",
    chunk_no: 1,
    title: "Политика возврата",
    content: "Для возврата заказа уточните номер заказа и причину возврата товара.",
  },
  {
    organization_id: ORG_A,
    document_id: "doc-a-delivery",
    chunk_id: "chunk-a-delivery",
    chunk_no: 1,
    title: "Доставка",
    content: "Доставка заказа занимает один рабочий день по городу.",
  },
  {
    organization_id: ORG_B,
    document_id: "doc-b-return",
    chunk_id: "chunk-b-return",
    chunk_no: 1,
    title: "Возврат организации B",
    content: "Секретная политика возврата заказа организации B.",
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

/**
 * A minimal Backend that exposes C3.kb `POST /knowledge:search` over HTTP backed
 * by the in-memory Knowledge Base. It stands in for SVC-API/Backend so the e2e
 * exercises the real network path SVC-AI uses in production.
 */
function createBackendKbServer(kb) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.startsWith("/knowledge:search")) {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    const validation = validateKnowledgeSearchRequest(payload);
    if (!validation.valid) {
      response.writeHead(400, JSON_HEADERS);
      response.end(JSON.stringify({ error: validation.errors }));
      return;
    }

    const { results } = await kb.search({
      organizationId: payload.organization_id,
      embedding: payload.embedding,
      limit: payload.limit,
    });

    const body = createKnowledgeSearchResponse({
      organizationId: payload.organization_id,
      results,
    });
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(body));
  });
}

describe("E2E — AI Assistant из базы знаний (CP-3)", () => {
  const llm = createDeterministicMockLlm();
  let backendServer;
  let aiServer;
  let aiUrl;

  before(async () => {
    const kb = createInMemoryKbSearch({ chunks: KB_CHUNKS, llm });
    await kb.ensureEmbeddings();

    backendServer = createBackendKbServer(kb);
    const backendUrl = await listen(backendServer);

    aiServer = createAiPlatformServer({
      ai: createRagAssistant({
        llm,
        kbSearch: createBackendKbSearch({ baseUrl: backendUrl }),
      }),
      mode: "rag",
    });
    aiUrl = await listen(aiServer);
  });

  after(async () => {
    await close(aiServer);
    await close(backendServer);
  });

  async function ask(organizationId, query) {
    const response = await fetch(`${aiUrl}/api/v1/ai/assistant:suggest`, {
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
    assert.equal(response.status, 200);
    return response.json();
  }

  it("returns a KB-grounded answer with ranked source citations", async () => {
    const answer = await ask(ORG_A, "Как оформить возврат заказа?");

    assert.equal(answer.contract, "C4.AssistantSuggestResponse");
    assert.equal(answer.degraded, false);
    assert.equal(answer.suggestion.mode, "deterministic_mock");
    assert.equal(answer.source_status, "available");

    const ids = answer.sources.map((source) => source.chunk_id);
    assert.equal(ids[0], "chunk-a-return", "the return chunk is the closest match");
    assert.ok(answer.sources.every((source) => source.source_type === "knowledge_chunk"));
    assert.match(answer.suggestion.text, /\[1\]/);
    assert.ok(answer.suggestion.confidence > 0);
  });

  it("keeps tenant isolation across the full request path", async () => {
    const answer = await ask(ORG_A, "возврат заказа");
    const ids = answer.sources.map((source) => source.chunk_id);
    assert.ok(!ids.includes("chunk-b-return"), "ORG_B chunk must never reach ORG_A");
  });

  it("marks answers with no KB match as sourceless but still available", async () => {
    const answer = await ask("10000000-0000-4000-8000-0000000000c1", "возврат");
    assert.equal(answer.source_status, "available");
    assert.equal(answer.sources.length, 1);
    assert.equal(answer.sources[0].source_type, "none");
  });
});
