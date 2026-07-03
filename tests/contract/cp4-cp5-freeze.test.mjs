import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const freezePath = join(root, "packages", "contracts", "cp4-cp5-freeze.v1.json");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readFreeze() {
  return JSON.parse(readFileSync(freezePath, "utf8"));
}

describe("CP-4/CP-5 M3 facade freeze", () => {
  it("freezes C5 at CP-4 and stabilizes C3/C4/C5 at CP-5 as the M4 baseline", () => {
    const freeze = readFreeze();

    assert.equal(freeze["x-gate"], "CP-4+CP-5");
    assert.equal(freeze["x-stage"], "M3");
    assert.equal(freeze["x-status"], "complete");
    assert.equal(freeze.frozen_at, "2026-07-03");
    assert.deepEqual(
      freeze.contracts.map((contract) => contract.id),
      ["C5", "C3", "C4"],
    );
    assert.deepEqual(freeze.m4_readiness.stable_contracts, ["C3", "C4", "C5"]);
    assert.deepEqual(freeze.m4_readiness.stable_data_surfaces, [
      "outbox_events",
      "workflow_*",
    ]);
  });

  it("points every frozen contract at existing artifacts and evidence", () => {
    const freeze = readFreeze();

    for (const contract of freeze.contracts) {
      assert.equal(contract.status, "stable_for_m4");
      assert.ok(contract.evidence.length > 0);
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

  it("publishes the frozen facade operations in the backend-core OpenAPI", () => {
    const openApi = readJson("packages/contracts/openapi/backend-core/openapi.json");
    const freeze = readFreeze();

    const frozenOperations = freeze.contracts.flatMap((contract) => contract.surface);
    for (const { method, path } of frozenOperations) {
      assert.ok(openApi.paths[path], `backend-core OpenAPI is missing ${path}`);
      assert.ok(
        openApi.paths[path][method],
        `backend-core OpenAPI ${path} must expose ${method.toUpperCase()}`,
      );
    }
  });

  it("keeps the AI unavailable and Workflow-only-write invariants in scope", () => {
    const freeze = readFreeze();

    assert.deepEqual(freeze.scope.scenarios, [
      "Workflow вызывает Backend API node",
      "Admin правит Workflow",
      "AI Onboarding применяет конфигурацию через Backend",
    ]);
    assert.ok(
      freeze.scope.invariants.includes(
        "Backend is the only sanctioned way to change data from Workflow/AI",
      ),
    );
    assert.ok(
      freeze.scope.invariants.includes(
        "rights checked against the real principal, never self-declared context roles",
      ),
    );
    assert.ok(
      freeze.scope.invariants.includes(
        "AI/Workflow actions audited with actor_type = ai|workflow",
      ),
    );
    assert.ok(
      freeze.scope.invariants.includes(
        "outbox replay is idempotent and does not duplicate Workflow starts",
      ),
    );
    assert.ok(
      freeze.scope.invariants.includes(
        "workflow_* rows are tenant-isolated and execution logs are insertable",
      ),
    );
  });
});
