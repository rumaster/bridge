#!/usr/bin/env node
/**
 * Генератор каталога вызовов Backend API для узла «Вызов Backend API».
 *
 * Источник истины — `openapi/backend-core/openapi.json`, который сам генерируется
 * из кода Backend (`services/backend/src/tools/export-openapi.ts`). Каталог
 * выкладывается статическим TS-модулем, а не читается из JSON в рантайме: его
 * грузит редактор в браузере, а `c5.ts` с `node:fs` там непригоден — ровно из-за
 * этого контракт и раскалывается на браузеро-безопасные модули.
 *
 * Использование:
 *   node packages/contracts/scripts/generate-backend-api-catalog.mjs         — записать
 *   node packages/contracts/scripts/generate-backend-api-catalog.mjs --check — проверить синхронность
 *
 * Режим --check ничего не пишет: сравнивает сгенерированное с тем, что на диске,
 * и падает при расхождении. Так добавление маршрута /api/v1 без перегенерации
 * каталога ловится в CI, а не в редакторе у оператора.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const openapiPath = join(packageRoot, "openapi", "backend-core", "openapi.json");
const outputPath = join(packageRoot, "src", "backend-api-catalog.generated.ts");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function buildCatalog() {
  const document = JSON.parse(readFileSync(openapiPath, "utf8"));
  const operations = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      const pathParams = [...path.matchAll(PLACEHOLDER)].map((match) => match[1]);
      const queryParams = parameters.filter((p) => p.in === "query").map((p) => p.name).sort();

      operations.push({
        operation_id: operation.operationId ?? `${method}_${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? "",
        tag: (operation.tags ?? [])[0] ?? "other",
        path_params: pathParams,
        query_params: queryParams,
        has_body: Boolean(operation.requestBody),
      });
    }
  }

  operations.sort((a, b) => a.operation_id.localeCompare(b.operation_id));
  return operations;
}

function render(operations) {
  const header = `// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать вручную.
// Источник: packages/contracts/openapi/backend-core/openapi.json
// Генератор: packages/contracts/scripts/generate-backend-api-catalog.mjs
// Обновить: npm run generate --workspace=@bridge/contracts
//
// Каталог операций Backend API, доступных узлу «Вызов Backend API». Витрину
// поверх каталога курирует platform_operator (таблица workflow_backend_api_allowlist):
// каталог отвечает на вопрос «что вообще существует», allowlist — «что разрешено
// дёргать из схемы».

/** Операция Backend API, которую может вызвать узел схемы. */
export interface BackendApiOperation {
  readonly operation_id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  /** Плейсхолдеры пути: каждому нужен одноимённый входной порт узла. */
  readonly path_params: readonly string[];
  readonly query_params: readonly string[];
  readonly has_body: boolean;
}

export const BACKEND_API_OPERATIONS: readonly BackendApiOperation[] = Object.freeze([
`;

  const body = operations
    .map((operation) => {
      const pathParams = operation.path_params.map((name) => JSON.stringify(name)).join(", ");
      const queryParams = operation.query_params.map((name) => JSON.stringify(name)).join(", ");
      return `  {
    operation_id: ${JSON.stringify(operation.operation_id)},
    method: ${JSON.stringify(operation.method)},
    path: ${JSON.stringify(operation.path)},
    summary: ${JSON.stringify(operation.summary)},
    tag: ${JSON.stringify(operation.tag)},
    path_params: Object.freeze([${pathParams}]),
    query_params: Object.freeze([${queryParams}]),
    has_body: ${operation.has_body},
  },`;
    })
    .join("\n");

  const footer = `
] as const);

const BY_ID = new Map<string, BackendApiOperation>(
  BACKEND_API_OPERATIONS.map((operation) => [operation.operation_id, operation]),
);

export function getBackendApiOperation(operationId: string): BackendApiOperation | null {
  return BY_ID.get(operationId) ?? null;
}

export function isBackendApiOperationId(value: unknown): boolean {
  return typeof value === "string" && BY_ID.has(value);
}
`;

  return `${header}${body}${footer}`;
}

const operations = buildCatalog();
const rendered = render(operations);
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== rendered) {
    console.error(
      "packages/contracts: каталог Backend API разошёлся с OpenAPI.\n" +
        "Перегенерируйте: npm run generate --workspace=@bridge/contracts",
    );
    process.exit(1);
  }
  console.log(`packages/contracts: каталог Backend API синхронен (${operations.length} операций).`);
} else {
  writeFileSync(outputPath, rendered);
  console.log(`packages/contracts: каталог Backend API записан (${operations.length} операций).`);
}
