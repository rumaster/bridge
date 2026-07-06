import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AI_ASSISTANT_SUGGEST_RESPONSE_SCHEMA,
  createAssistantSuggestResponse,
  validateAssistantSuggestResponse,
} from "../../packages/contracts/src/c4.js";
import {
  createKnowledgeSearchRequest,
  validateKnowledgeSearchRequest,
  createKnowledgeSearchResponse,
  validateKnowledgeSearchResponse,
  KB_EMBEDDING_DIMENSIONS,
} from "../../packages/contracts/src/c3-kb.js";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("CP-3 SVC-API/ai-integration C4 consumer contract", () => {
  const contract = readJson(
    "packages/contracts/consumer/ai-integration-c4.consumer.v1.json",
  );

  it("declares SVC-API as the CP-3 consumer of C4 and provider of C3.kb", () => {
    assert.equal(contract["x-contract-id"], "CP3.ai-integration.consumer");
    assert.equal(contract["x-consumer"], "SVC-API");
    assert.equal(contract["x-stage"], "M2");
    assert.deepEqual(contract.upstream_contracts, ["C4", "C3.kb"]);
  });

  it("consumes the frozen C4 assistant suggestion operation", () => {
    const c4OpenApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const suggest = contract.interactions.find(
      (interaction) =>
        interaction.contract === "C4" &&
        interaction.path === "/ai/assistant:suggest",
    );

    assert.ok(suggest);
    assert.ok(c4OpenApi.paths["/ai/assistant:suggest"].post);
    assert.deepEqual(suggest.request.required, [
      "contract",
      "version",
      "request_id",
      "organization_id",
      "query",
    ]);
    assert.equal(
      suggest.degradation.aiUnavailableKeepsMessagingUsable,
      true,
    );
    assert.deepEqual(suggest.response.sources.item_source_types, [
      "knowledge_chunk",
      "none",
    ]);
  });

  it("keeps the standalone C4 response schema in sync with the frozen OpenAPI", () => {
    const c4OpenApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const openApiResponse = c4OpenApi.components.schemas.AssistantSuggestResponse;

    assert.deepEqual(
      AI_ASSISTANT_SUGGEST_RESPONSE_SCHEMA.required,
      openApiResponse.required,
    );
    assert.deepEqual(
      Object.keys(AI_ASSISTANT_SUGGEST_RESPONSE_SCHEMA.properties),
      Object.keys(openApiResponse.properties),
    );
  });

  it("validates a RAG response with Knowledge Base citations", () => {
    const response = createAssistantSuggestResponse({
      requestId: "req-1",
      organizationId: "org-1",
      suggestion: {
        mode: "deterministic_mock",
        text: "Ответ на основе базы знаний [1].",
        confidence: 0.8,
      },
      sourceStatus: "available",
      sources: [
        {
          source_type: "knowledge_chunk",
          document_id: "doc-1",
          chunk_id: "chunk-1",
          title: "Политика доставки",
          excerpt: "Доставка занимает один рабочий день.",
        },
      ],
      now: () => "2026-07-03T10:00:00.000Z",
    });

    const validation = validateAssistantSuggestResponse(response);
    assert.equal(validation.valid, true, validation.errors.join("\n"));
  });

  it("publishes and validates the C3.kb search request/response contract", () => {
    const embedding = Array.from({ length: KB_EMBEDDING_DIMENSIONS }, () => 0);
    const request = createKnowledgeSearchRequest({
      organizationId: "org-1",
      embedding,
      query: "доставка",
      limit: 5,
    });
    assert.equal(validateKnowledgeSearchRequest(request).valid, true);

    const response = createKnowledgeSearchResponse({
      organizationId: "org-1",
      results: [
        {
          document_id: "doc-1",
          chunk_id: "chunk-1",
          chunk_no: 1,
          title: "Политика доставки",
          content: "Доставка занимает один рабочий день.",
          distance: 0.12,
          metadata: {},
        },
      ],
    });
    assert.equal(validateKnowledgeSearchResponse(response).valid, true);

    const provided = contract.provides.find(
      (item) => item.contract === "C3.kb" && item.path === "/knowledge:search",
    );
    assert.ok(provided);
    assert.equal(provided.isolation.noCrossTenantResults, true);
  });

  it("rejects a C3.kb request with a wrong embedding dimensionality", () => {
    assert.throws(() =>
      createKnowledgeSearchRequest({
        organizationId: "org-1",
        embedding: [0, 1, 2],
      }),
    );
  });
});
