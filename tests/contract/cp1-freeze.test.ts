import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CP1_CONTRACT_FREEZE,
  CP1_GATE_REQUIRED_CONTRACT_IDS,
  validateCp1ContractFreeze,
} from "../../packages/contracts/src/registry.js";

const root = process.cwd();
const freezePath = join(root, "packages", "contracts", "cp1-freeze.v1.json");

function readFreeze() {
  return JSON.parse(readFileSync(freezePath, "utf8"));
}

describe("CP-1 M1 contract freeze", () => {
  it("freezes C1/C2/C3/C7 as the stable M2 baseline", () => {
    const freeze = readFreeze();
    const validation = validateCp1ContractFreeze();

    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.equal(freeze["x-gate"], "CP-1");
    assert.equal(freeze["x-stage"], "M1");
    assert.equal(freeze["x-status"], "complete");
    assert.equal(freeze.frozen_at, "2026-07-03");
    assert.deepEqual(
      freeze.contracts.map((contract) => contract.id),
      CP1_GATE_REQUIRED_CONTRACT_IDS,
    );
    assert.deepEqual(
      CP1_CONTRACT_FREEZE.map((contract) => contract.id),
      CP1_GATE_REQUIRED_CONTRACT_IDS,
    );
    assert.deepEqual(freeze.m2_readiness.stable_contracts, [
      "C1",
      "C2",
      "C3",
      "C7",
    ]);
  });

  it("links every CP-1 artifact and evidence file to the repository", () => {
    const freeze = readFreeze();

    for (const contract of freeze.contracts) {
      assert.equal(contract.status, "stable_for_m2");

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

  it("records CP-1 scenarios, invariants and M2 readiness scope", () => {
    const freeze = readFreeze();

    assert.deepEqual(freeze.scope.scenarios, [
      "Web Chat: приём и ответ",
      "Авторизация",
      "Работа менеджера",
    ]);
    assert.deepEqual(freeze.scope.invariants, [
      "tenant isolation (RLS)",
      "idempotent POST /messages",
      "received -> routed -> sent status transitions",
      "audit events for mutating operations",
    ]);
    assert.deepEqual(freeze.m2_readiness.next_scope, [
      "adapters",
      "realtime",
      "AI Assistant",
      "identity resolution",
    ]);
  });
});
