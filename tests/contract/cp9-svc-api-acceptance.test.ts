import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const acceptancePath = join(root, "packages", "contracts", "cp9-svc-api-acceptance.v1.json");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readAcceptance() {
  return JSON.parse(readFileSync(acceptancePath, "utf8"));
}

describe("CP-9 SVC-API M5 acceptance", () => {
  it("freezes the M5 C3 acceptance gate and version policy", () => {
    const acceptance = readAcceptance();
    const c3 = acceptance.contracts.find((contract) => contract.id === "C3");

    assert.equal(acceptance["x-gate"], "CP-9");
    assert.equal(acceptance["x-stage"], "M5");
    assert.equal(acceptance["x-status"], "complete");
    assert.equal(acceptance.accepted_at, "2026-07-04");
    assert.ok(c3);
    assert.equal(c3.status, "ready_for_cp9");
    assert.equal(c3.base_path, "/api/v1");
    assert.deepEqual(c3.versioning.operational_aliases, ["GET /health", "GET /metrics"]);
    assert.equal(c3.versioning.breaking_changes, "publish a new URL version; never break /api/v1");
  });

  it("points every C3 artifact and evidence entry at an existing file", () => {
    const acceptance = readAcceptance();

    for (const contract of acceptance.contracts) {
      for (const artifact of contract.artifacts) {
        assert.doesNotThrow(
          () => accessSync(join(root, artifact)),
          `${contract.id} artifact is missing: ${artifact}`,
        );
      }
      for (const evidence of contract.evidence) {
        assert.doesNotThrow(
          () => accessSync(join(root, evidence)),
          `${contract.id} evidence is missing: ${evidence}`,
        );
      }
    }
  });

  it("keeps the CP-9 acceptance metadata synchronized with backend-core OpenAPI", () => {
    const acceptance = readAcceptance();
    const c3 = acceptance.contracts.find((contract) => contract.id === "C3");
    const openApi = readJson(c3.openapi.artifact);
    const operationCount = Object.values(openApi.paths).reduce(
      (count: number, methods) => count + Object.keys(methods).length,
      0,
    );

    assert.equal(openApi.info.version, c3.version);
    assert.equal(openApi["x-contract-id"], c3.openapi.metadata["x-contract-id"]);
    assert.equal(openApi["x-owner"], c3.openapi.metadata["x-owner"]);
    assert.equal(openApi["x-stage"], c3.openapi.metadata["x-stage"]);
    assert.equal(openApi["x-api-version"], c3.openapi.metadata["x-api-version"]);
    assert.equal(openApi["x-api-version-strategy"].currentPrefix, c3.base_path);
    assert.equal(openApi["x-api-version-strategy"].type, c3.versioning.strategy);
    assert.equal(operationCount, c3.openapi.generated_operation_count);
    assert.equal(Object.keys(openApi.paths).length, c3.openapi.generated_path_count);
    assert.ok(Object.keys(openApi.paths).every((path) => path.startsWith(c3.base_path)));
  });

  it("publishes the accepted M5 surface and NFR probes in backend-core OpenAPI", () => {
    const acceptance = readAcceptance();
    const c3 = acceptance.contracts.find((contract) => contract.id === "C3");
    const openApi = readJson(c3.openapi.artifact);
    const probesByKey = new Map<string, any>(c3.nfr.probes.map((probe) => [probe.key, probe]));

    for (const { method, path, nfr_key: nfrKey } of c3.surface) {
      assert.ok(openApi.paths[path], `backend-core OpenAPI is missing ${path}`);
      assert.ok(
        openApi.paths[path][method],
        `backend-core OpenAPI ${path} must expose ${method.toUpperCase()}`,
      );

      if (nfrKey) {
        const probe = probesByKey.get(nfrKey);
        assert.ok(probe, `${nfrKey} NFR probe is missing`);
        assert.equal(probe.path, path);
        assert.equal(probe.method.toLowerCase(), method);
        assert.ok(probe.target_ms > 0);
      }
    }

    assert.equal(c3.nfr.percentile, "p95");
    assert.equal(c3.nfr.external_llm_time, "excluded");
    assert.deepEqual(
      c3.nfr.probes.map((probe) => [probe.key, probe.target_ms]),
      [
        ["conversation_list", 1000],
        ["message_history", 2000],
        ["send_message", 1000],
        ["ai_assistant_without_llm", 500],
      ],
    );
  });
});
