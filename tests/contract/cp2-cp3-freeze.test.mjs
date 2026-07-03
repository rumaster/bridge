import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const freezePath = join(root, "packages", "contracts", "cp2-cp3-freeze.v1.json");

function readFreeze() {
  return JSON.parse(readFileSync(freezePath, "utf8"));
}

describe("CP-2/CP-3 M2 contract freeze", () => {
  it("freezes C2/C6/C4 as the stable M3 baseline", () => {
    const freeze = readFreeze();

    assert.equal(freeze["x-gate"], "CP-2+CP-3");
    assert.equal(freeze["x-stage"], "M2");
    assert.equal(freeze["x-status"], "complete");
    assert.equal(freeze.frozen_at, "2026-07-03");
    assert.deepEqual(
      freeze.contracts.map((contract) => contract.id),
      ["C2", "C6", "C4"],
    );
    assert.deepEqual(freeze.m3_readiness.stable_contracts, ["C2", "C6", "C4"]);
  });

  it("points every frozen contract at evidence for CP-2/CP-3 scenarios", () => {
    const freeze = readFreeze();

    for (const contract of freeze.contracts) {
      assert.equal(contract.status, "stable_for_m3");
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

    assert.deepEqual(freeze.scope.scenarios, [
      "Telegram: приём и ответ",
      "AI Assistant из KB",
    ]);
    assert.deepEqual(freeze.scope.invariants, [
      "capability-based channel routing",
      "tenant-isolated KB search",
      "endpoint-scoped sequence ordering",
      "C7 realtime reconnect without duplicates",
      "AI unavailable degradation keeps messaging usable",
    ]);
  });
});
