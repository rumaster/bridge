/**
 * Полезные нагрузки C3.kb — поиск по базе знаний между Backend и SVC-AI.
 *
 * Модуль НЕ ИМЕЕТ НИ ОДНОГО ИМПОРТА и потому собирается в CommonJS: `c3-kb.ts`
 * тянет `node:fs` (читает JSON-схемы) и `c4.ts`, поэтому непригоден для Backend,
 * который компилируется в CommonJS с `rootDir: "src"`. Разделение — то же, что у
 * `c5.ts` / `c5-workflow.ts`, и по той же причине: без собранного пакета «общий
 * контракт» остаётся на словах, а обе стороны заводят свои копии и расходятся.
 *
 * Здесь это не абстрактный риск. SVC-AI проверяет ответ Backend по
 * `C3_KB_SEARCH_RESPONSE_SCHEMA` и на несоответствие бросает `KbSearchError`,
 * который RAG-ассистент ловит и молча деградирует до заглушки. То есть расхождение
 * формы ответа не падает, а тихо выключает базу знаний — ровно так этот контур и
 * был сломан. Поэтому ответ обязан собираться общей функцией, а не руками.
 */

export const C3_KB_VERSION = "1.0.0";

/**
 * Размерность эмбеддинга. Инвариант: модель и размерность у Backend (документы) и
 * SVC-AI (запросы) обязаны совпадать, иначе расстояния бессмысленны и поиск молча
 * возвращает мусор.
 */
export const KB_EMBEDDING_DIMENSIONS = 1536;

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

function normalizeHit(hit: KnowledgeHit): KnowledgeHit {
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
