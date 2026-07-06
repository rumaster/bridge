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

/** Полезная нагрузка запроса C3.kb.SearchRequest. */
export interface KnowledgeSearchRequest {
  contract: string;
  version: string;
  organization_id: string;
  embedding: number[];
  query?: string;
  limit?: number;
}

/** Входные данные {@link createKnowledgeSearchRequest}. */
export interface CreateKnowledgeSearchRequestInput {
  organizationId: string;
  embedding: number[];
  query?: string;
  limit?: number;
}

/** Одна запись результата поиска по базе знаний (C3.kb). */
export interface KnowledgeHit {
  document_id: unknown;
  chunk_id: unknown;
  chunk_no: unknown;
  content: unknown;
  distance: unknown;
  title?: unknown;
  metadata?: unknown;
}

/** Полезная нагрузка ответа C3.kb.SearchResponse. */
export interface KnowledgeSearchResponse {
  contract: string;
  version: string;
  organization_id: string;
  results: KnowledgeHit[];
}

/** Входные данные {@link createKnowledgeSearchResponse}. */
export interface CreateKnowledgeSearchResponseInput {
  organizationId: string;
  results?: KnowledgeHit[];
}

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
}: CreateKnowledgeSearchRequestInput): KnowledgeSearchRequest {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new TypeError("createKnowledgeSearchRequest requires organizationId");
  }

  if (!Array.isArray(embedding) || embedding.length !== KB_EMBEDDING_DIMENSIONS) {
    throw new TypeError(
      `createKnowledgeSearchRequest requires a ${KB_EMBEDDING_DIMENSIONS}-dimension embedding`,
    );
  }

  const request: KnowledgeSearchRequest = {
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

export function createKnowledgeSearchResponse({
  organizationId,
  results = [],
}: CreateKnowledgeSearchResponseInput): KnowledgeSearchResponse {
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

function normalizeHit(hit): KnowledgeHit {
  const normalized: KnowledgeHit = {
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
