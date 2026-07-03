import assert from "node:assert/strict";
import { accessSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  M0_CONTRACT_REGISTRY,
  M0_GATE_REQUIRED_CONTRACT_IDS,
  validateM0ContractRegistry,
} from "../../src/registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("M0 contract registry", () => {
  it("publishes every contract required by the M0 integration gate", () => {
    const validation = validateM0ContractRegistry();

    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.deepEqual(
      M0_CONTRACT_REGISTRY.map((contract) => contract.id),
      M0_GATE_REQUIRED_CONTRACT_IDS,
    );
  });

  it("points every registered artifact at an existing file", () => {
    for (const contract of M0_CONTRACT_REGISTRY) {
      for (const artifact of contract.artifacts) {
        assert.doesNotThrow(
          () => accessSync(join(repoRoot, artifact)),
          `${contract.id} artifact is missing: ${artifact}`,
        );
      }
    }
  });

  it("keeps contract IDs, artifact paths and DTO names conflict-free", () => {
    const ids = new Set(M0_CONTRACT_REGISTRY.map((contract) => contract.id));
    const artifacts = new Set(
      M0_CONTRACT_REGISTRY.flatMap((contract) => contract.artifacts),
    );
    const dtoNames = new Set(
      M0_CONTRACT_REGISTRY.flatMap((contract) => contract.dtoNames),
    );

    assert.equal(ids.size, M0_CONTRACT_REGISTRY.length);
    assert.equal(
      artifacts.size,
      M0_CONTRACT_REGISTRY.flatMap((contract) => contract.artifacts).length,
    );
    assert.equal(
      dtoNames.size,
      M0_CONTRACT_REGISTRY.flatMap((contract) => contract.dtoNames).length,
    );
  });
});
