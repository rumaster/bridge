import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

const cp6cp7 = readJson("packages/contracts/cp6-cp7-freeze.v1.json");
const cp8 = readJson("packages/contracts/cp8-freeze.v1.json");

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

describe("M4-99 integration gate — CP-6/CP-7/CP-8 freeze", () => {
  it("freezes C8 at CP-6 and C9 at CP-7 as the M5 baseline", () => {
    assert.equal(cp6cp7["x-gate"], "CP-6+CP-7");
    assert.equal(cp6cp7["x-stage"], "M4");
    assert.equal(cp6cp7["x-status"], "complete");
    assert.deepEqual(
      cp6cp7.contracts.map((contract) => contract.id),
      ["C8", "C9", "C1", "C2"],
    );
    for (const contract of cp6cp7.contracts) {
      assert.equal(
        contract.status,
        "stable_for_m5",
        `${contract.id} must be frozen as stable_for_m5`,
      );
    }
    assert.deepEqual(cp6cp7.m5_readiness.stable_contracts, [
      "C1",
      "C2",
      "C8",
      "C9",
    ]);
  });

  it("freezes C10 and notification.created at CP-8 as the M5 baseline", () => {
    assert.equal(cp8["x-gate"], "CP-8");
    assert.equal(cp8["x-stage"], "M4");
    assert.equal(cp8["x-status"], "complete");
    assert.equal(cp8.frozen_at, "2026-07-04");
    assert.deepEqual(
      cp8.contracts.map((contract) => contract.id),
      ["C10", "C7.notification.created"],
    );
    for (const contract of cp8.contracts) {
      assert.equal(
        contract.status,
        "stable_for_m5",
        `${contract.id} must be frozen as stable_for_m5`,
      );
      assert.equal(contract.owner, "SVC-NOTIF");
    }
    assert.deepEqual(cp8.m5_readiness.stable_contracts, [
      "C10",
      "C7.notification.created",
    ]);
    assert.deepEqual(cp8.m5_readiness.stable_data_surfaces, [
      "notifications",
      "notification_settings",
    ]);
  });

  it("points every frozen M4 contract at existing artifacts and evidence", () => {
    assertArtifactsExist(cp6cp7);
    assertArtifactsExist(cp8);
  });

  it("publishes the frozen C10 operations in the notifications OpenAPI", () => {
    const openApi = readJson(
      "packages/contracts/openapi/notifications/c10.notifications.openapi.json",
    );
    assert.equal(openApi["x-contract-id"], "C10");
    assert.equal(openApi["x-owner"], "SVC-NOTIF");

    const restOperations = cp8.contracts
      .flatMap((contract) => contract.surface)
      .filter((entry) => entry.method && entry.path);
    assert.ok(restOperations.length >= 4, "C10 must freeze its REST surface");
    for (const { method, path } of restOperations) {
      assert.ok(openApi.paths[path], `notifications OpenAPI is missing ${path}`);
      assert.ok(
        openApi.paths[path][method],
        `notifications OpenAPI ${path} must expose ${method.toUpperCase()}`,
      );
    }
  });

  it("keeps the notification.created event owned solely by SVC-NOTIF", () => {
    const createdSchema = readJson(
      "packages/contracts/events/notification-created.schema.json",
    );
    assert.equal(createdSchema["x-owner"], "SVC-NOTIF");
    assert.equal(createdSchema.additionalProperties, false);
    assert.equal(
      createdSchema.properties.event.const,
      "notification.created",
    );

    const notificationCreated = cp8.contracts.find(
      (contract) => contract.id === "C7.notification.created",
    );
    assert.ok(notificationCreated, "notification.created must be frozen at CP-8");
    assert.deepEqual(notificationCreated.surface, [
      {
        contract: "C7.NotificationCreatedEvent",
        event: "notification.created",
      },
    ]);
  });

  it("locks the cross-cutting M4 invariants across all three CPs", () => {
    const cp6cp7Invariants = cp6cp7.scope.invariants;
    const cp8Invariants = cp8.scope.invariants;

    // CP-6/CP-7: end-to-end idempotency, single core delivery, order recovery, dedup.
    assert.ok(
      cp6cp7Invariants.includes(
        "end-to-end idempotency by messages.id = idempotency_key = message_id",
      ),
      "idempotency_key = message_id must be frozen",
    );
    assert.ok(
      cp6cp7Invariants.includes(
        "campaigns deliver strictly through core C1/C2, never bypassing SVC-CORE",
      ),
      "single core delivery mechanism must be frozen",
    );
    assert.ok(
      cp6cp7Invariants.some((line) =>
        line.includes("order recovered by (endpoint_id, sequence_number)"),
      ),
      "sequence_number order recovery must be frozen",
    );
    assert.ok(
      cp6cp7Invariants.some((line) =>
        line.includes("duplicate transitions are dropped"),
      ),
      "dedup across client->Edge->buffer->Core->Adapter must be frozen",
    );

    // CP-8: producers-only-via-trigger, single owner, subscription-aware delivery, RLS.
    assert.ok(
      cp8Invariants.some((line) =>
        line.includes("SVC-NOTIF is the single owner of notification.created"),
      ),
      "single notification owner must be frozen",
    );
    assert.ok(
      cp8Invariants.some((line) =>
        line.includes("a disabled channel is never delivered"),
      ),
      "subscription-aware delivery must be frozen",
    );
    assert.ok(
      cp8Invariants.some((line) => line.includes("tenant-isolated by organization_id")),
      "RLS tenant isolation must be frozen at CP-8",
    );
  });

  it("binds each M4 CP to a passing e2e scenario", () => {
    const gateEvidence = [
      // CP-6 «Broadcast: доставка кампании»
      "tests/e2e/backend-dist-communication-core.test.mjs",
      "tests/e2e/broadcast-delivery-cp6.test.mjs",
      // CP-7 «Потеря соединения» + «Edge Cluster»
      "services/edge-gateway/test/unit/edge-cluster.test.mjs",
      "tests/integration/edge-message-buffer-store.test.mjs",
      "tests/e2e/mobile-connection-loss-cp7.test.mjs",
      // CP-8 «Notification в Web + Telegram»
      "tests/e2e/notification-subscriptions-cp8.test.mjs",
      "tests/e2e/telegram-console-cp8.test.mjs",
      // Cross-CP contract binding BCAST<->CORE, EDGE<->CORE, producers<->NOTIF
      "tests/contract/c8-broadcast-contract.test.mjs",
      "tests/contract/edge-core-c9-c7.contract.test.mjs",
      "tests/contract/c10-notification-contract.test.mjs",
    ];
    for (const evidence of gateEvidence) {
      assert.doesNotThrow(
        () => accessSync(join(root, evidence)),
        `M4 gate scenario evidence is missing: ${evidence}`,
      );
    }
  });
});
