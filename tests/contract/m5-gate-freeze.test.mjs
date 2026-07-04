import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { M0_GATE_REQUIRED_CONTRACT_IDS } from "../../packages/contracts/src/registry.mjs";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

const cp9 = readJson("packages/contracts/cp9-freeze.v1.json");

function assertArtifactsExist(freeze) {
  for (const contract of freeze.contracts) {
    assert.ok(
      contract.artifacts.length > 0,
      `${contract.id} must reference at least one artifact`,
    );
    assert.ok(
      contract.evidence.length > 0,
      `${contract.id} must reference at least one evidence file`,
    );
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
}

describe("M5-99 integration gate — CP-9 final v1 freeze", () => {
  it("marks CP-9 as the final, complete M5 freeze", () => {
    assert.equal(cp9["x-gate"], "CP-9");
    assert.equal(cp9["x-stage"], "M5");
    assert.equal(cp9["x-status"], "complete");
    assert.equal(cp9["x-final"], true);
    assert.equal(cp9.accepted_at, "2026-07-04");
  });

  it("freezes every planned v1 contract as released_v1", () => {
    const ids = cp9.contracts.map((contract) => contract.id);
    // Every gate-required contract from the M0 registry must be released at CP-9.
    for (const requiredId of M0_GATE_REQUIRED_CONTRACT_IDS) {
      assert.ok(
        ids.includes(requiredId),
        `CP-9 freeze is missing required contract ${requiredId}`,
      );
    }
    for (const contract of cp9.contracts) {
      assert.equal(
        contract.status,
        "released_v1",
        `${contract.id} must be released_v1 at CP-9`,
      );
      assert.match(
        contract.version,
        /^\d+\.\d+\.\d+$/,
        `${contract.id} must carry a semver version`,
      );
    }
    assert.deepEqual(cp9.release_v1.released_contracts, ids);
  });

  it("keeps the mobile contract on an independent semver line", () => {
    const mobile = cp9.contracts.find((contract) => contract.id === "MOBILE.v1");
    assert.ok(mobile, "MOBILE.v1 must be frozen at CP-9");
    assert.equal(mobile.version, "1.1.0");
    assert.equal(mobile.base_path, "/mobile/v1");
    assert.equal(mobile.versioning.strategy, "independent-semver");
    assert.equal(mobile.versioning.previous_version, "1.0.0");
  });

  it("keeps /api/v1 as the stable core URL contract with /api/v2 as the escape hatch", () => {
    const core = cp9.contracts.find((contract) => contract.id === "C3.base");
    assert.ok(core, "C3.base must be frozen at CP-9");
    assert.equal(core.versioning.current_prefix, "/api/v1");
    assert.equal(core.versioning.next_breaking_version, "/api/v2");
    assert.deepEqual(cp9.release_v1.stable_url_prefixes, ["/api/v1", "/mobile/v1"]);
    assert.equal(cp9.release_v1.next_breaking_version, "/api/v2");
  });

  it("keeps notification.created owned solely by SVC-NOTIF inside C7", () => {
    const c7 = cp9.contracts.find((contract) => contract.id === "C7");
    const notificationCreated = c7.surface.find(
      (entry) => entry.event === "notification.created",
    );
    assert.ok(notificationCreated, "notification.created must be frozen inside C7");
    assert.equal(notificationCreated.owner, "SVC-NOTIF");

    const createdSchema = readJson(
      "packages/contracts/events/notification-created.schema.json",
    );
    assert.equal(createdSchema["x-owner"], "SVC-NOTIF");
    assert.equal(createdSchema.additionalProperties, false);
    assert.equal(createdSchema.properties.event.const, "notification.created");
  });

  it("points every released contract at existing artifacts and evidence", () => {
    assertArtifactsExist(cp9);
  });

  it("consolidates every prior CP freeze artifact", () => {
    const expected = [
      "packages/contracts/cp1-freeze.v1.json",
      "packages/contracts/cp2-cp3-freeze.v1.json",
      "packages/contracts/cp4-cp5-freeze.v1.json",
      "packages/contracts/cp6-cp7-freeze.v1.json",
      "packages/contracts/cp8-freeze.v1.json",
      "packages/contracts/cp9-svc-api-acceptance.v1.json",
    ];
    assert.deepEqual(cp9.consolidates, expected);
    for (const path of cp9.consolidates) {
      assert.doesNotThrow(
        () => accessSync(join(root, path)),
        `consolidated freeze is missing: ${path}`,
      );
    }
  });

  it("binds acceptance §29 to existing NFR, security and RPO/RTO evidence", () => {
    const buckets = ["nfr", "security_review", "rpo_rto"];
    for (const bucket of buckets) {
      const evidence = cp9.acceptance[bucket].evidence;
      assert.ok(
        Array.isArray(evidence) && evidence.length > 0,
        `acceptance.${bucket} must reference evidence`,
      );
      for (const path of evidence) {
        assert.doesNotThrow(
          () => accessSync(join(root, path)),
          `acceptance.${bucket} evidence is missing: ${path}`,
        );
      }
    }
    assert.equal(cp9.acceptance.e2e_regression.scenario_count, 11);
    assert.equal(cp9.acceptance.nfr.external_llm_time, "excluded");
  });

  it("binds each §26.6 acceptance scenario to a passing e2e file", () => {
    const gateEvidence = [
      // Авторизация / Работа менеджера / Web Chat / Telegram
      "apps/saas-admin/test/e2e/saas-admin.auth.spec.ts",
      "apps/manager-workspace/test/e2e/manager-workspace.m1.spec.ts",
      "tests/e2e/backend-dist-communication-core.test.mjs",
      "services/backend/test/integration/telegram-auth.spec.ts",
      // AI Assistant / Workflow / AI Onboarding
      "tests/e2e/ai-assistant-kb.test.mjs",
      "tests/e2e/workflow-engine-cp4-cp5.test.mjs",
      "tests/e2e/workflow-fbp-m5-cp9.test.mjs",
      "tests/e2e/ai-onboarding-apply.test.mjs",
      // Notification / Broadcast
      "tests/e2e/notification-delivery-cp9.test.mjs",
      "tests/e2e/telegram-console-cp8.test.mjs",
      "tests/e2e/broadcast-delivery-cp6.test.mjs",
      // Edge Cluster / Потеря соединения
      "services/edge-gateway/test/unit/edge-cluster.test.mjs",
      "tests/integration/edge-message-buffer-store.test.mjs",
      "tests/e2e/mobile-connection-loss-cp7.test.mjs",
    ];
    for (const evidence of gateEvidence) {
      assert.doesNotThrow(
        () => accessSync(join(root, evidence)),
        `M5 gate scenario evidence is missing: ${evidence}`,
      );
    }
  });

  it("locks the cross-cutting M5 release invariants", () => {
    const invariants = cp9.scope.invariants;
    const has = (needle) =>
      invariants.some((line) => line.includes(needle));
    assert.ok(
      has("released_v1"),
      "freeze must lock the released_v1 status of all contracts",
    );
    assert.ok(
      has("только новой версией"),
      "freeze must lock the no-mutation versioning policy (§7.4/§9.3)",
    );
    assert.ok(
      has("messages.id = idempotency_key = message_id"),
      "freeze must lock end-to-end idempotency",
    );
    assert.ok(
      has("RLS"),
      "freeze must lock tenant isolation (RLS)",
    );
    assert.ok(
      has("append-only"),
      "freeze must lock append-only audit protection",
    );
  });
});
