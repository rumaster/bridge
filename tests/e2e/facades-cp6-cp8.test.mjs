import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  validateBroadcastCoreDeliveryDraft,
} from "../../packages/contracts/src/c8.mjs";
import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../packages/contracts/src/c10.mjs";
import { createBroadcastPlatformServer } from "../../services/broadcast-platform/src/server.mjs";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.mjs";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-cp6-cp8";
const USER = "manager-cp6-cp8";
const JSON_HEADERS = {
  "content-type": "application/json",
};
const NOTIFICATION_HEADERS = {
  ...JSON_HEADERS,
  "x-bridge-organization-id": ORG,
  "x-bridge-user-id": USER,
};

describe("CP-6/CP-8 facade e2e (contract-level chain)", () => {
  let broadcastServer;
  let broadcastBaseUrl;
  let notificationServer;
  let notificationBaseUrl;

  before(async () => {
    broadcastServer = createBroadcastPlatformServer({ now: fixedNow });
    broadcastBaseUrl = await listen(broadcastServer);

    notificationServer = createNotificationPlatformServer({ now: fixedNow });
    notificationBaseUrl = await listen(notificationServer);
  });

  after(async () => {
    await close(notificationServer);
    await close(broadcastServer);
  });

  it("CP-6: creates and starts a broadcast with a valid C8 delivery draft for CORE C1/C2", async () => {
    const createResponse = await fetch(`${broadcastBaseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C8.CreateBroadcastRequest",
        version: "1.0.0",
        request_id: "req-cp6-broadcast-create",
        organization_id: ORG,
        created_by: USER,
        name: "CP-6 broadcast",
        template: {
          type: "text",
          body: "CP-6 broadcast message",
          variables: [],
        },
        filter: {
          mode: "all",
          channels: ["web_chat"],
          tags: [],
          segment_ids: [],
          criteria: {},
        },
        schedule: {
          mode: "manual",
        },
        rate_limit: {
          messages_per_minute: 60,
          strategy: "fixed",
        },
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.contract, "C8.CreateBroadcastResponse");
    assert.equal(created.broadcast.organization_id, ORG);

    const startResponse = await fetch(
      `${broadcastBaseUrl}/api/v1/broadcasts/${created.broadcast.id}:start`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contract: "C8.StartBroadcastRequest",
          version: "1.0.0",
          request_id: "req-cp6-broadcast-start",
          organization_id: ORG,
          started_by: USER,
          mode: "immediate",
          idempotency_key: "idem-cp6-broadcast-start",
        }),
      },
    );
    const started = await startResponse.json();

    assert.equal(startResponse.status, 200);
    assert.equal(started.contract, "C8.StartBroadcastResponse");
    // CP-6/M4: :start прогоняет кампанию через единый механизм ядра до конца.
    assert.equal(started.broadcast.status, "done");
    assert.equal(
      validateBroadcastCoreDeliveryDraft(started.core_delivery_draft).valid,
      true,
    );
    assert.equal(started.core_delivery_draft.delivery_path, "C1/C2");

    const statsResponse = await fetch(
      `${broadcastBaseUrl}/api/v1/broadcasts/${created.broadcast.id}/stats?organization_id=${ORG}&request_id=req-cp6-broadcast-stats`,
    );
    const stats = await statsResponse.json();

    assert.equal(statsResponse.status, 200);
    assert.equal(stats.contract, "C8.BroadcastStatsResponse");
    assert.equal(stats.broadcast_id, created.broadcast.id);
    assert.equal(stats.status, "done");
    assert.equal(stats.stats.sent, 3);
  });

  it("CP-8: accepts a producer event, exposes the notification, marks it read and keeps settings mutable", async () => {
    const settingsUpdateResponse = await fetch(
      `${notificationBaseUrl}/api/v1/notifications/settings`,
      {
        method: "PUT",
        headers: {
          ...NOTIFICATION_HEADERS,
          "x-request-id": "req-cp8-settings-put",
        },
        body: JSON.stringify({
          contract: "C10.UpdateNotificationSettingsRequest",
          version: "1.0.0",
          request_id: "req-cp8-settings-put",
          organization_id: ORG,
          user_id: USER,
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
      },
    );
    const updatedSettings = await settingsUpdateResponse.json();

    assert.equal(settingsUpdateResponse.status, 200);
    assert.deepEqual(
      updatedSettings.settings
        .filter((setting) => setting.category === "critical" && setting.enabled)
        .map((setting) => setting.channel)
        .sort(),
      ["telegram", "web"],
    );

    const trigger = createNotificationTriggerEvent({
      eventId: "cp8-broadcast-delivery-1:notif",
      producerServiceId: "SVC-BCAST",
      producerEventId: "broadcast-cp6:failed",
      organizationId: ORG,
      recipientUserId: USER,
      category: "critical",
      title: "Broadcast delivery needs attention",
      body: "CP-6 broadcast delivery reported a failed recipient.",
      payload: {
        broadcast_id: "broadcast-cp6",
        failed: 1,
      },
      dedupeKey: "SVC-BCAST:broadcast-cp6:failed",
      occurredAt: fixedNow(),
    });

    const producerResponse = await fetch(
      `${notificationBaseUrl}/api/v1/internal/notifications/events`,
      {
        method: "POST",
        headers: NOTIFICATION_HEADERS,
        body: JSON.stringify(trigger),
      },
    );
    const accepted = await producerResponse.json();

    assert.equal(producerResponse.status, 202);
    assert.equal(accepted.contract, "C10.AcceptNotificationTriggerResponse");
    assert.equal(accepted.notification.category, "critical");
    assert.equal(accepted.notification.channels.includes("telegram"), true);
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );

    const listResponse = await fetch(
      `${notificationBaseUrl}/api/v1/notifications?category=critical&limit=10`,
      {
        headers: {
          ...NOTIFICATION_HEADERS,
          "x-request-id": "req-cp8-notifications-list",
        },
      },
    );
    const list = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, accepted.notification.id);

    const readResponse = await fetch(
      `${notificationBaseUrl}/api/v1/notifications/${accepted.notification.id}:read`,
      {
        method: "POST",
        headers: {
          ...NOTIFICATION_HEADERS,
          "x-request-id": "req-cp8-notification-read",
        },
      },
    );
    const read = await readResponse.json();

    assert.equal(readResponse.status, 200);
    assert.equal(read.contract, "C10.MarkNotificationReadResponse");
    assert.equal(read.notification.status, "read");

    const settingsGetResponse = await fetch(
      `${notificationBaseUrl}/api/v1/notifications/settings`,
      {
        headers: {
          ...NOTIFICATION_HEADERS,
          "x-request-id": "req-cp8-settings-get",
        },
      },
    );
    const currentSettings = await settingsGetResponse.json();

    assert.equal(settingsGetResponse.status, 200);
    assert.deepEqual(
      currentSettings.settings
        .filter((setting) => setting.category === "critical" && setting.enabled)
        .map((setting) => setting.channel)
        .sort(),
      ["telegram", "web"],
    );
  });
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
