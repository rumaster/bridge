import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.js";

/**
 * C3.kb — поиск по базе знаний между Backend и SVC-AI.
 *
 * Здесь остаётся только то, что требует `node:fs`: загрузка JSON-схем и валидация
 * по ним. Сборщики полезной нагрузки и константы живут в `c3-kb-payloads.ts` —
 * модуле без импортов, который собирается в CommonJS и потому доступен Backend
 * (см. пояснение там же). Ре-экспорт сохранён, чтобы существующие импорты
 * `@bridge/contracts/c3-kb` продолжали работать без правок.
 */

export {
  C3_KB_VERSION,
  KB_EMBEDDING_DIMENSIONS,
  createKnowledgeSearchRequest,
  createKnowledgeSearchResponse,
} from "./c3-kb-payloads.js";

export type {
  CreateKnowledgeSearchRequestInput,
  CreateKnowledgeSearchResponseInput,
  KnowledgeHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from "./c3-kb-payloads.js";

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

export function validateKnowledgeSearchRequest(request) {
  return validateJsonSchema(request, C3_KB_SEARCH_REQUEST_SCHEMA);
}

export function validateKnowledgeSearchResponse(response) {
  return validateJsonSchema(response, C3_KB_SEARCH_RESPONSE_SCHEMA);
}
