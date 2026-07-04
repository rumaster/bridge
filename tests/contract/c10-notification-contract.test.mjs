import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
  validateNotificationTriggerEvent,
} from "../../packages/contracts/src/c10.mjs";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.mjs";

const root = process.cwd();
const fixedNow = () => "2026-07-02T16:31:00.000Z";
const JSON_HEADERS = {
  "content-type": "application/json",
  "x-bridge-organization-id": "org-1",
  "x-bridge-user-id": "manager-1",
};

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("NOTIF <-> producers/MWS/TGC M0 C10 contract", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createNotificationPlatformServer({ now: fixedNow });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("publishes the frozen C10 OpenAPI operations", () => {
    const openApi = readJson(
      "packages/contracts/openapi/notifications/c10.notifications.openapi.json",
    );

    assert.equal(openApi["x-contract-id"], "C10");
    assert.equal(openApi["x-owner"], "SVC-NOTIF");
    assert.equal(openApi.info.version, "1.0.0");
    assert.deepEqual(openApi.servers, [{ url: "/api/v1" }]);
    assert.ok(openApi.paths["/notifications"].get);
    assert.ok(openApi.paths["/notifications/{id}:read"].post);
    assert.ok(openApi.paths["/notifications/settings"].get);
    assert.ok(openApi.paths["/notifications/settings"].put);
  });

  it("freezes notification.created and producer trigger event schemas", () => {
    const createdSchema = readJson(
      "packages/contracts/events/notification-created.schema.json",
    );
    const triggerSchema = readJson(
      "packages/contracts/events/notification-trigger.schema.json",
    );
    const trigger = createNotificationTriggerEvent({
      eventId: "fbp-instance-1:notif",
      producerServiceId: "SVC-FBP",
      producerEventId: "workflow-instance-1:completed",
      organizationId: "org-1",
      recipientUserId: "manager-1",
      category: "info",
      title: "Workflow completed",
      body: "Workflow workflow-1 completed.",
      payload: {
        workflow_id: "workflow-1",
      },
      dedupeKey: "SVC-FBP:workflow-instance-1:completed:manager-1",
      occurredAt: fixedNow(),
    });

    assert.equal(createdSchema.properties.event.const, "notification.created");
    assert.equal(createdSchema["x-owner"], "SVC-NOTIF");
    assert.equal(triggerSchema.properties.event.const, "notification.triggered");
    assert.equal(validateNotificationTriggerEvent(trigger).valid, true);
  });

  it("smokes producer -> NOTIF -> notification.created exchange against the mock provider", async () => {
    const trigger = createNotificationTriggerEvent({
      eventId: "core-message-1:notif",
      producerServiceId: "SVC-CORE",
      producerEventId: "message-1:created",
      organizationId: "org-1",
      recipientUserId: "manager-1",
      category: "critical",
      title: "New priority message",
      body: "Client sent a priority message.",
      payload: {
        conversation_id: "conversation-1",
        message_id: "message-1",
      },
      dedupeKey: "SVC-CORE:message-1:manager-1",
      occurredAt: fixedNow(),
    });

    const producerResponse = await fetch(
      `${baseUrl}/api/v1/internal/notifications/events`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(trigger),
      },
    );
    const accepted = await producerResponse.json();

    assert.equal(producerResponse.status, 202);
    assert.equal(accepted.contract, "C10.AcceptNotificationTriggerResponse");
    assert.equal(accepted.notification.category, "critical");
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );

    const listResponse = await fetch(
      `${baseUrl}/api/v1/notifications?category=critical`,
      {
        headers: {
          ...JSON_HEADERS,
          "x-request-id": "req-list-critical-1",
        },
      },
    );
    const list = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, accepted.notification.id);
  });

  it("deduplicates a replayed producer trigger without a second notification", async () => {
    const dedupeKey = "SVC-AI:insight-1:manager-1";
    const build = (eventId) =>
      createNotificationTriggerEvent({
        eventId,
        producerServiceId: "SVC-AI",
        producerEventId: "insight-1:ready",
        organizationId: "org-1",
        recipientUserId: "manager-1",
        category: "info",
        title: "AI insight ready",
        body: "A new insight is available.",
        payload: { insight_id: "insight-1" },
        dedupeKey,
        occurredAt: fixedNow(),
      });

    const first = await (
      await fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(build("ai-insight-1:notif")),
      })
    ).json();
    const second = await (
      await fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(build("ai-insight-1:notif-retry")),
      })
    ).json();

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.notification.id, first.notification.id);

    // NOTIF -> MWS/TGC: доставки выражены как записи с провайдером и ссылкой.
    assert.ok(first.deliveries.length >= 1);
    for (const delivery of first.deliveries) {
      assert.equal(delivery.status, "sent");
      assert.equal(typeof delivery.provider, "string");
      assert.equal(typeof delivery.provider_ref, "string");
    }
    assert.ok(first.deliveries.some((delivery) => delivery.channel === "telegram"));
  });

  it("smokes C10 settings and read-state endpoints for MWS/TGC consumers", async () => {
    const settingsResponse = await fetch(`${baseUrl}/api/v1/notifications/settings`, {
      headers: {
        ...JSON_HEADERS,
        "x-request-id": "req-settings-get-1",
      },
    });
    const settings = await settingsResponse.json();

    assert.equal(settingsResponse.status, 200);
    assert.equal(settings.contract, "C10.NotificationSettingsResponse");
    assert.ok(settings.settings.some((item) => item.channel === "telegram"));

    const updateResponse = await fetch(`${baseUrl}/api/v1/notifications/settings`, {
      method: "PUT",
      headers: {
        ...JSON_HEADERS,
        "x-request-id": "req-settings-put-1",
      },
      body: JSON.stringify({
        contract: "C10.UpdateNotificationSettingsRequest",
        version: "1.0.0",
        request_id: "req-settings-put-1",
        organization_id: "org-1",
        user_id: "manager-1",
        settings: [
          {
            category: "critical",
            channel: "web",
            enabled: true,
          },
          {
            category: "critical",
            channel: "telegram",
            enabled: true,
          },
        ],
      }),
    });
    const updated = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.deepEqual(
      updated.settings
        .filter((item) => item.category === "critical" && item.enabled)
        .map((item) => item.channel)
        .sort(),
      ["telegram", "web"],
    );

    const listResponse = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: {
        ...JSON_HEADERS,
        "x-request-id": "req-list-read-1",
      },
    });
    const list = await listResponse.json();
    const readResponse = await fetch(
      `${baseUrl}/api/v1/notifications/${list.items[0].id}:read`,
      {
        method: "POST",
        headers: {
          ...JSON_HEADERS,
          "x-request-id": "req-read-1",
        },
      },
    );
    const read = await readResponse.json();

    assert.equal(readResponse.status, 200);
    assert.equal(read.notification.status, "read");
  });
});
