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

/** Маршрут без плейсхолдеров — совпадение по точному ключу "METHOD /path". */
const BY_ROUTE = new Map<string, BackendApiOperation>(
  BACKEND_API_OPERATIONS.filter((operation) => operation.path_params.length === 0).map(
    (operation) => [\`\${operation.method} \${operation.path}\`, operation],
  ),
);

interface TemplateRoute {
  readonly operation: BackendApiOperation;
  readonly segments: readonly string[];
}

/**
 * Шаблонные маршруты, отсортированные так, чтобы статический сегмент побеждал
 * плейсхолдер левее по пути. Без порядка запрос вида \`/api/v1/a/b\` мог бы
 * разрешиться то в \`/api/v1/a/{id}\`, то в \`/api/v1/{x}/b\` в зависимости от порядка
 * операций в OpenAPI — а от того, во что он разрешится, зависит проверка витрины.
 */
const TEMPLATE_ROUTES: readonly TemplateRoute[] = BACKEND_API_OPERATIONS.filter(
  (operation) => operation.path_params.length > 0,
)
  .map((operation) => ({ operation, segments: splitPathSegments(operation.path) }))
  .sort((left, right) => {
    const length = Math.min(left.segments.length, right.segments.length);
    for (let index = 0; index < length; index += 1) {
      const leftDynamic = isPlaceholderSegment(left.segments[index]);
      const rightDynamic = isPlaceholderSegment(right.segments[index]);
      if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
    }
    return left.operation.path.localeCompare(right.operation.path);
  });

function splitPathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/**
 * Обратный резолв конкретного запроса в операцию каталога: \`GET /api/v1/clients/42\`
 * → \`ClientController_get_v1\`. Нужен там, где на входе уже готовый HTTP-запрос, а
 * решение принимается по \`operation_id\` — например, когда витрина
 * \`workflow_backend_api_allowlist\` проверяется в рантайме, а не при сохранении схемы.
 *
 * Маршрут, которого нет в каталоге, возвращает \`null\`: вызывающая сторона обязана
 * трактовать это как запрет, а не как «проверить нечего».
 */
export function resolveBackendApiOperation(
  method: string,
  path: string,
): BackendApiOperation | null {
  const normalizedMethod = String(method ?? "").toUpperCase();
  // Query и фрагмент к выбору маршрута отношения не имеют; хвостовой слэш — тоже.
  const normalizedPath = String(path ?? "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\\/+$/, "");

  if (normalizedPath === "") return null;

  const exact = BY_ROUTE.get(\`\${normalizedMethod} \${normalizedPath}\`);
  if (exact) return exact;

  const requestSegments = splitPathSegments(normalizedPath);

  for (const route of TEMPLATE_ROUTES) {
    if (route.operation.method !== normalizedMethod) continue;
    if (route.segments.length !== requestSegments.length) continue;

    const matches = route.segments.every((segment, index) => {
      const requested = requestSegments[index];
      // Плейсхолдер принимает любой НЕПУСТОЙ сегмент: пустой означал бы, что
      // параметр не подставлен, а такой запрос до API всё равно не дойдёт.
      return isPlaceholderSegment(segment) ? requested !== "" : segment === requested;
    });

    if (matches) return route.operation;
  }

  return null;
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
