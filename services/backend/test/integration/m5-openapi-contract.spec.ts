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

  it("keeps only operational health and metrics aliases outside /api/v1", () => {
    expect(unversionedExpressOperations(app)).toEqual(["GET /health", "GET /metrics"]);
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
