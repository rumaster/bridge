import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { OpenAPIObject } from "@nestjs/swagger";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { buildOpenApiDocument } from "../../src/common/openapi/openapi";

const ROOT = resolve(__dirname, "../../../..");
const BACKEND_OPENAPI_PATH = join(
  ROOT,
  "packages/contracts/openapi/backend-core/openapi.json",
);
const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

type OpenApiWithExtensions = OpenAPIObject & Record<string, unknown>;
type PathItemLike = Record<string, unknown>;

describe("SVC-API M5 OpenAPI contract", () => {
  let app: INestApplication;
  let generated: OpenApiWithExtensions;
  let published: OpenApiWithExtensions;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();

    generated = buildOpenApiDocument(app) as OpenApiWithExtensions;
    published = JSON.parse(readFileSync(BACKEND_OPENAPI_PATH, "utf8")) as OpenApiWithExtensions;
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps the published backend-core artifact byte-for-byte generated from code", () => {
    expect(published).toEqual(generated);
  });

  it("publishes every actual versioned Nest route in backend-core OpenAPI", () => {
    expect(versionedExpressOperations(app)).toEqual(openApiOperations(generated));
  });

  it("keeps only operational aliases and internal service-to-service routes outside /api/v1", () => {
    // GET /health, /metrics — операционные алиасы. POST /internal/* — внутренний
    // messaging-путь (issue #189): integration-platform вызывает эти маршруты по
    // фиксированным путям без префикса `api`/версии (CORE_INGRESS_URL и т.п.),
    // поэтому они намеренно исключены из глобального префикса и не публикуются в
    // backend-core OpenAPI (тесты byte-for-byte и versioned-routes это подтверждают).
    //
    // POST /knowledge:search — внутренний семантический поиск C3.kb (ТЗ §12.10,
    // добавлен 2026-07-15). SVC-AI зовёт его по этому документированному пути, тоже
    // без префикса и версии. До его появления маршрута не существовало вовсе, и
    // RAG-ассистент молча деградировал до заглушки на каждом запросе.
    //
    // Двоеточие здесь — ЛИТЕРАЛ, и это ровно то, что проверяет строка ниже: маршрут
    // объявлен как `knowledge\\:search`, потому что без экранирования path-to-regexp
    // Express 5 разбирает `:search` как параметр и маршрут начинает отвечать на
    // `/knowledge<что угодно>`. Параметр отрендерился бы здесь как `/knowledge{search}`
    // — именно так этот тест поймал ошибку в первой версии маршрута.
    expect(unversionedExpressOperations(app)).toEqual([
      "GET /health",
      "GET /internal/channels",
      "GET /internal/channels/secret",
      "GET /metrics",
      "POST /internal/broadcast/deliveries",
      "POST /internal/delivery/attempts",
      "POST /internal/edge/tunnel/messages",
      "POST /internal/egress/messages",
      "POST /internal/ingress/messages",
      "POST /knowledge:search",
    ]);
  });

  it("keeps every path parameter a whole segment, so `:verb` routes stay literal", () => {
    // Ловит целый класс ошибок, который иначе проходит ВЕСЬ прогон зелёным.
    //
    // Маршруты-действия объявляются с экранированным двоеточием (`@Post("x\\:verb")`).
    // Забыть `\\` легко, а последствия тихие: path-to-regexp Express 5 разбирает
    // `:verb` как ПАРАМЕТР, и маршрут начинает отвечать на `/x<что угодно>`. При этом
    // Swagger рендерит тот же `:verb` в `{verb}` — то есть и Express, и OpenAPI
    // согласованно описывают неверный маршрут, и тест «publishes every actual
    // versioned Nest route» их расхождения не видит (проверено: он остаётся зелёным).
    //
    // Отличие видно по форме. Параметр всегда ОТКРЫВАЕТ сегмент: `/documents/{id}`,
    // `/broadcasts/{id}:start` (параметр плюс литеральный глагол — так и задумано).
    // Забытое экранирование, наоборот, приклеивает параметр ПОСЛЕ текста:
    // `/documents{search}`. Запрещается именно это.
    const glued = Object.keys(generated.paths).filter((path) =>
      path.split("/").some((segment) => segment.includes("{") && !segment.startsWith("{")),
    );

    expect(glued).toEqual([]);
  });

  it("documents C3 v1 compatibility and the no-breaking-change policy for CP-9", () => {
    expect(generated.info.version).toBe("1.0.0");
    expect(generated["x-contract-id"]).toBe("C3");
    expect(generated["x-owner"]).toBe("SVC-API");
    expect(generated["x-stage"]).toBe("M5");
    expect(generated["x-api-version"]).toBe("v1");
    expect(generated["x-api-version-strategy"]).toEqual({
      breakingChanges: "publish a new URL version; never break /api/v1",
      currentPrefix: "/api/v1",
      type: "uri",
    });
  });
});

function versionedExpressOperations(app: INestApplication): string[] {
  return expressOperations(app).filter((operation) => operation.includes(" /api/v1/")).sort();
}

function unversionedExpressOperations(app: INestApplication): string[] {
  return expressOperations(app).filter((operation) => !operation.includes(" /api/v1/")).sort();
}

function expressOperations(app: INestApplication): string[] {
  return expressRouteLayers(app)
    .flatMap((layer) => {
      if (!layer.route) {
        return [];
      }

      const path = normalizeExpressPath(layer.route.path);
      return Object.keys(layer.route.methods)
        .filter((method) => HTTP_METHODS.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`);
    })
    .sort();
}

function expressRouteLayers(app: INestApplication): RouteLayer[] {
  const express = app.getHttpAdapter().getInstance() as {
    _router?: { stack?: RouteLayer[] };
    router?: { stack?: RouteLayer[] };
  };

  return express._router?.stack ?? express.router?.stack ?? [];
}

function normalizeExpressPath(path: string): string {
  const literalColon = "\u0000literal-colon\u0000";

  return path
    .replaceAll("\\:", literalColon)
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replaceAll(literalColon, ":");
}

function openApiOperations(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem as PathItemLike)
        .filter(([method, operation]) => HTTP_METHODS.has(method) && isOperation(operation))
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function isOperation(value: unknown): value is { responses: unknown } {
  return Boolean(value && typeof value === "object" && "responses" in value);
}

interface RouteLayer {
  route?: {
    methods: Record<string, boolean>;
    path: string;
  };
}
