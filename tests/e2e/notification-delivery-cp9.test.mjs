import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../packages/contracts/src/c10.mjs";
import { createDefaultChannelAdapters } from "../../services/notification-platform/src/channel-adapters.mjs";
import { createDeterministicNotificationMock } from "../../services/notification-platform/src/deterministic-notification.mjs";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.mjs";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-cp9-notif";
const USER = "manager-cp9";

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-bridge-organization-id": ORG,
    "x-bridge-user-id": USER,
    ...extra,
  };
}

function failingChannelAdapter(channel, message = `${channel} is unavailable`) {
  let attempts = 0;

  return {
    channel,
    deliver() {
      attempts += 1;
      throw new Error(message);
    },
    getAttempts() {
      return attempts;
    },
    getDispatches() {
      return [];
    },
  };
}

async function triggerCriticalNotification(baseUrl) {
  const trigger = createNotificationTriggerEvent({
    eventId: "cp9-notif:critical",
    producerServiceId: "SVC-CORE",
    producerEventId: "message-cp9:created",
    organizationId: ORG,
    recipientUserId: USER,
    category: "critical",
    title: "New priority message",
    body: "Client sent a priority message.",
    payload: { conversation_id: "conversation-cp9" },
    dedupeKey: "SVC-CORE:message-cp9:manager-cp9",
    occurredAt: fixedNow(),
  });

  return fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(trigger),
  });
}

describe("CP-9 e2e: critical notification degrades across Web + Telegram", () => {
  let server;
  let baseUrl;
  let telegram;

  before(async () => {
    telegram = failingChannelAdapter("telegram", "telegram provider is down");
    const channels = {
      ...createDefaultChannelAdapters({ now: fixedNow }),
      telegram,
    };
    const notifications = createDeterministicNotificationMock({
      now: fixedNow,
      channels,
    });

    server = createNotificationPlatformServer({ notifications, now: fixedNow });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("keeps Web delivery and C10 state when Telegram Console delivery fails", async () => {
    const response = await triggerCriticalNotification(baseUrl);
    const accepted = await response.json();

    assert.equal(response.status, 202);
    assert.equal(accepted.degraded, true);
    assert.deepEqual(
      accepted.deliveries
        .filter((delivery) => delivery.status === "sent")
        .map((delivery) => delivery.channel),
      ["web"],
    );
    assert.equal(accepted.failed_deliveries[0].channel, "telegram");
    assert.equal(accepted.failed_deliveries[0].attempts, 3);
    assert.equal(telegram.getAttempts(), 3);
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );

    const listed = await (
      await fetch(`${baseUrl}/api/v1/notifications?category=critical`, {
        headers: headers({ "x-request-id": "req-cp9-list" }),
      })
    ).json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].category, "critical");
  });
});
