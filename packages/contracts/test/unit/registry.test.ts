import assert from "node:assert/strict";
import { accessSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CP1_CONTRACT_FREEZE,
  CP1_GATE_REQUIRED_CONTRACT_IDS,
  CP2_CP3_CONTRACT_FREEZE,
  CP2_CP3_GATE_REQUIRED_CONTRACT_IDS,
  M0_CONTRACT_REGISTRY,
  M0_GATE_REQUIRED_CONTRACT_IDS,
  validateCp1ContractFreeze,
  validateCp2Cp3ContractFreeze,
  validateM0ContractRegistry,
} from "../../src/registry.js";

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

describe("CP-1 contract freeze", () => {
  it("publishes C1/C2/C3/C7 as stable for M2", () => {
    const validation = validateCp1ContractFreeze();

    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.deepEqual(
      CP1_CONTRACT_FREEZE.map((contract) => contract.id),
      CP1_GATE_REQUIRED_CONTRACT_IDS,
    );

    for (const contract of CP1_CONTRACT_FREEZE) {
      assert.equal(contract.stage, "M1");
      assert.equal(contract.gate, "CP-1");
      assert.equal(contract.status, "stable_for_m2");
    }
  });

  it("points every frozen artifact and evidence file at an existing file", () => {
    for (const contract of CP1_CONTRACT_FREEZE) {
      for (const artifact of contract.artifacts) {
        assert.doesNotThrow(
          () => accessSync(join(repoRoot, artifact)),
          `${contract.id} artifact is missing: ${artifact}`,
        );
      }

      for (const evidence of contract.evidence) {
        assert.doesNotThrow(
          () => accessSync(join(repoRoot, evidence)),
          `${contract.id} evidence is missing: ${evidence}`,
        );
      }
    }
  });
});

describe("CP-2/CP-3 contract freeze", () => {
  it("publishes C2/C6/C4 as stable for M3", () => {
    const validation = validateCp2Cp3ContractFreeze();

    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.deepEqual(
      CP2_CP3_CONTRACT_FREEZE.map((contract) => contract.id),
      CP2_CP3_GATE_REQUIRED_CONTRACT_IDS,
    );

    for (const contract of CP2_CP3_CONTRACT_FREEZE) {
      assert.equal(contract.stage, "M2");
      assert.equal(contract.gate, "CP-2+CP-3");
      assert.equal(contract.status, "stable_for_m3");
    }
  });

  it("points every frozen artifact and evidence file at an existing file", () => {
    for (const contract of CP2_CP3_CONTRACT_FREEZE) {
      for (const artifact of contract.artifacts) {
        assert.doesNotThrow(
          () => accessSync(join(repoRoot, artifact)),
          `${contract.id} artifact is missing: ${artifact}`,
        );
      }

      for (const evidence of contract.evidence) {
        assert.doesNotThrow(
          () => accessSync(join(repoRoot, evidence)),
          `${contract.id} evidence is missing: ${evidence}`,
        );
      }
    }
  });
});
