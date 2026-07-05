import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.js";

export const C3_KB_VERSION = "1.0.0";

export const KB_EMBEDDING_DIMENSIONS = 1536;

export const C3_KB_SEARCH_REQUEST_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c3-kb-search-request.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const C3_KB_SEARCH_RESPONSE_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c3-kb-search-response.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

/**
 * Build a C3.kb search request. The embedding is computed by SVC-AI (through the
 * swappable LLM abstraction); the actual pgvector search with tenant isolation is
 * executed by Backend (SVC-AI never touches the database directly, ТЗ §12.10).
 */
export function createKnowledgeSearchRequest({
  organizationId,
  embedding,
  query,
  limit,
}) {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new TypeError("createKnowledgeSearchRequest requires organizationId");
  }

  if (!Array.isArray(embedding) || embedding.length !== KB_EMBEDDING_DIMENSIONS) {
    throw new TypeError(
      `createKnowledgeSearchRequest requires a ${KB_EMBEDDING_DIMENSIONS}-dimension embedding`,
    );
  }

  const request = {
    contract: "C3.kb.SearchRequest",
    version: C3_KB_VERSION,
    organization_id: organizationId,
    embedding,
  };

  if (typeof query === "string") {
    request.query = query;
  }

  if (limit !== undefined) {
    request.limit = limit;
  }

  return request;
}

export function validateKnowledgeSearchRequest(request) {
  return validateJsonSchema(request, C3_KB_SEARCH_REQUEST_SCHEMA);
}

export function createKnowledgeSearchResponse({ organizationId, results = [] }) {
  return {
    contract: "C3.kb.SearchResponse",
    version: C3_KB_VERSION,
    organization_id: organizationId,
    results: results.map((hit) => normalizeHit(hit)),
  };
}

export function validateKnowledgeSearchResponse(response) {
  return validateJsonSchema(response, C3_KB_SEARCH_RESPONSE_SCHEMA);
}

function normalizeHit(hit) {
  const normalized = {
    document_id: hit.document_id,
    chunk_id: hit.chunk_id,
    chunk_no: hit.chunk_no,
    content: hit.content,
    distance: hit.distance,
  };

  if (hit.title !== undefined) {
    normalized.title = hit.title;
  }

  if (hit.metadata !== undefined) {
    normalized.metadata = hit.metadata;
  }

  return normalized;
}
