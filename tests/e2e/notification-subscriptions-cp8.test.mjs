import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../packages/contracts/src/c10.mjs";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.mjs";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-cp8-subs";

function headersFor(user, extra = {}) {
  return {
    "content-type": "application/json",
    "x-bridge-organization-id": ORG,
    "x-bridge-user-id": user,
    ...extra,
  };
}

async function setSubscriptions(baseUrl, user, settings) {
  const response = await fetch(`${baseUrl}/api/v1/notifications/settings`, {
    method: "PUT",
    headers: headersFor(user, { "x-request-id": `req-settings-${user}` }),
    body: JSON.stringify({
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: `req-settings-${user}`,
      organization_id: ORG,
      user_id: user,
      settings,
    }),
  });
  assert.equal(response.status, 200);
}

async function triggerFor(baseUrl, user, dedupeKey, eventId) {
  const trigger = createNotificationTriggerEvent({
    eventId,
    producerServiceId: "SVC-CORE",
    producerEventId: "message-cp8:created",
    organizationId: ORG,
    recipientUserId: user,
    category: "critical",
    title: "New priority message",
    body: "Client sent a priority message.",
    payload: { conversation_id: "conversation-cp8" },
    dedupeKey,
    occurredAt: fixedNow(),
  });
  return fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
    method: "POST",
    headers: headersFor(user),
    body: JSON.stringify(trigger),
  });
}

describe("CP-8 e2e: notification in Web + Telegram under different subscriptions", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createNotificationPlatformServer({ now: fixedNow });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("delivers to Web + Telegram for a user subscribed to both channels", async () => {
    const user = "manager-both";
    await setSubscriptions(baseUrl, user, [
      { category: "critical", channel: "web", enabled: true },
      { category: "critical", channel: "telegram", enabled: true },
    ]);

    const accepted = await (
      await triggerFor(baseUrl, user, "cp8:both:1", "cp8-both:notif")
    ).json();

    assert.deepEqual(
      accepted.deliveries.map((delivery) => delivery.channel).sort(),
      ["telegram", "web"],
    );
    assert.equal(accepted.notification.channels.includes("telegram"), true);
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );
  });

  it("delivers only to Web when the user disabled Telegram", async () => {
    const user = "manager-web-only";
    await setSubscriptions(baseUrl, user, [
      { category: "critical", channel: "web", enabled: true },
      { category: "critical", channel: "telegram", enabled: false },
    ]);

    const accepted = await (
      await triggerFor(baseUrl, user, "cp8:webonly:1", "cp8-webonly:notif")
    ).json();

    assert.deepEqual(
      accepted.deliveries.map((delivery) => delivery.channel),
      ["web"],
    );
    assert.equal(accepted.skipped_channels.includes("telegram"), true);
    // Web-событие C7 всё равно публикуется для SVC-MWS.
    assert.equal(accepted.notification_created_event.event, "notification.created");
  });

  it("never creates a duplicate when the same logical event is replayed", async () => {
    const user = "manager-dedupe";
    await setSubscriptions(baseUrl, user, [
      { category: "critical", channel: "web", enabled: true },
      { category: "critical", channel: "telegram", enabled: true },
    ]);

    await triggerFor(baseUrl, user, "cp8:dedupe:1", "cp8-dedupe:notif-a");
    const replay = await (
      await triggerFor(baseUrl, user, "cp8:dedupe:1", "cp8-dedupe:notif-b")
    ).json();
    assert.equal(replay.duplicate, true);

    const list = await (
      await fetch(`${baseUrl}/api/v1/notifications?category=critical`, {
        headers: headersFor(user, { "x-request-id": "req-dedupe-list" }),
      })
    ).json();
    assert.equal(list.items.length, 1);
  });
});
