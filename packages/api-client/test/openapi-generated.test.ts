import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generatedOpenApiDocuments,
  generatedOpenApiOperations,
  resolveGeneratedOpenApiOperation,
} from "../src/index.js";

describe("@bridge/api-client generated OpenAPI catalog", () => {
  it("publishes operations generated from the repository OpenAPI contracts", () => {
    const operationIds = new Set(generatedOpenApiOperations.map((operation) => operation.operationId));
    const artifacts = new Set(generatedOpenApiDocuments.map((document) => document.artifact));

    assert.ok(operationIds.has("HealthController_getHealth_v1"));
    assert.ok(operationIds.has("connectC7WebSocket"));
    assert.ok(operationIds.has("dispatchEgressDelivery"));
    assert.ok(artifacts.has("packages/contracts/openapi/backend-core/openapi.json"));
    assert.ok(artifacts.has("packages/contracts/openapi/c2-internal-api.yaml"));
  });

  it("resolves generated operations by operationId", () => {
    assert.equal(resolveGeneratedOpenApiOperation("connectC7WebSocket").path, "/ws");
  });
});
