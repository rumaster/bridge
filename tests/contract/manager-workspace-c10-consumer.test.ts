import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const contractPath = join(
  root,
  "packages",
  "contracts",
  "consumer",
  "manager-workspace-c10.consumer.v1.json",
);

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

describe("SVC-MWS CP-8 C10/C7 notification consumer contract", () => {
  it("publishes the CP-8 consumer contract for C10 and C7", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "CP8.manager-workspace.consumer");
    assert.equal(contract["x-consumer"], "SVC-MWS");
    assert.deepEqual(contract.upstream_contracts, ["C10", "C7"]);
  });

  it("consumes the frozen C10 list and mark-read operations with published categories", () => {
    const contract = readContract();
    const c10OpenApi = readJson(
      "packages/contracts/openapi/notifications/c10.notifications.openapi.json",
    );

    const list = contract.interactions.find(
      (interaction) => interaction.operationId === "listNotifications",
    );
    const markRead = contract.interactions.find(
      (interaction) => interaction.operationId === "markNotificationRead",
    );

    assert.ok(list);
    assert.ok(markRead);

    const listOperation = c10OpenApi.paths["/notifications"].get;
    const markReadOperation = c10OpenApi.paths["/notifications/{id}:read"].post;
    assert.equal(listOperation.operationId, "listNotifications");
    assert.equal(markReadOperation.operationId, "markNotificationRead");

    // Consumed categories/statuses must match the frozen C10 enums.
    assert.deepEqual(
      list.response.categories,
      c10OpenApi.components.schemas.NotificationCategory.enum,
    );
    assert.deepEqual(
      list.response.statuses,
      c10OpenApi.components.schemas.NotificationStatus.enum,
    );

    // Every consumed field must exist on the frozen C10.Notification schema.
    const notificationFields = Object.keys(
      c10OpenApi.components.schemas.Notification.properties,
    );
    for (const field of list.response.consumed_fields) {
      assert.ok(
        notificationFields.includes(field),
        `${field} is not published by C10.Notification`,
      );
    }

    assert.equal(markRead.response.consumer_behavior.syncUnreadCounter, true);
    assert.equal(markRead.response.consumer_behavior.revertOnError, true);
  });

  it("consumes the C7 notification.created event and reconnect invariants", () => {
    const contract = readContract();
    const c7Schema = readJson("packages/contracts/events/c7-websocket-event.schema.json");
    const c7EventNames = c7Schema.properties.event.enum;

    assert.deepEqual(
      contract.events.map((event) => event.name),
      ["notification.created"],
    );

    const [notificationEvent] = contract.events;
    assert.ok(
      c7EventNames.includes(notificationEvent.name),
      `${notificationEvent.name} is not published by C7`,
    );
    assert.equal(notificationEvent.consumer_behavior.incrementUnreadCounter, true);
    assert.equal(notificationEvent.consumer_behavior.catchUpCursor, "sequence_number");
    assert.equal(
      notificationEvent.consumer_behavior.deduplicateBy,
      "payload.notification.id",
    );

    assert.deepEqual(contract.reconnect, {
      transportCursor: "last_event_id",
      eventDeduplication: "event_id",
      notificationDeduplication: "payload.notification.id",
      gapDetection: "sequence_number",
    });
  });
});
