import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../../../packages/contracts/src/c10.js";
import { createDefaultChannelAdapters } from "../../src/channel-adapters.js";
import { createDeterministicNotificationMock } from "../../src/deterministic-notification.js";
import { createNotificationPlatformServer } from "../../src/server.js";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-int";
const USER = "manager-int";

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-bridge-organization-id": ORG,
    "x-bridge-user-id": USER,
    ...extra,
  };
}

function trigger(overrides = {}) {
  return createNotificationTriggerEvent({
    eventId: "evt-int-1",
    producerServiceId: "SVC-BCAST",
    producerEventId: "broadcast-1:failed",
    organizationId: ORG,
    recipientUserId: USER,
    category: "critical",
    title: "Broadcast delivery needs attention",
    body: "A broadcast recipient failed.",
    payload: { broadcast_id: "broadcast-1" },
    dedupeKey: "SVC-BCAST:broadcast-1:failed",
    occurredAt: fixedNow(),
    ...overrides,
  });
}

async function putSettings(baseUrl, settings) {
  return fetch(`${baseUrl}/api/v1/notifications/settings`, {
    method: "PUT",
    headers: headers({ "x-request-id": "req-settings" }),
    body: JSON.stringify({
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: "req-settings",
      organization_id: ORG,
      user_id: USER,
      settings,
    }),
  });
}

async function postEvent(baseUrl, payload) {
  return fetch(`${baseUrl}/api/v1/internal/notifications/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

describe("Notification Platform delivery over HTTP (M3/M4)", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createNotificationPlatformServer({ now: fixedNow });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("accepts a producer event and emits a valid C7 notification.created event", async () => {
    const response = await postEvent(baseUrl, trigger());
    const accepted = await response.json();

    assert.equal(response.status, 202);
    assert.equal(accepted.contract, "C10.AcceptNotificationTriggerResponse");
    assert.equal(accepted.notification.category, "critical");
    assert.equal(
      validateNotificationCreatedEvent(accepted.notification_created_event).valid,
      true,
    );
    // Default web+telegram доставлены, email/push пропущены.
    assert.deepEqual(
      accepted.deliveries.map((delivery) => delivery.channel),
      ["web", "telegram"],
    );
  });

  it("deduplicates a replayed producer event over HTTP", async () => {
    const dedupeKey = "SVC-BCAST:dedupe-http:1";
    const first = await (await postEvent(baseUrl, trigger({ dedupeKey }))).json();
    const second = await (
      await postEvent(baseUrl, trigger({ dedupeKey, eventId: "evt-int-1-retry" }))
    ).json();

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.notification.id, first.notification.id);
  });

  it("delivers only to enabled channels after a subscription change", async () => {
    await putSettings(baseUrl, [
      { category: "warning", channel: "web", enabled: true },
      { category: "warning", channel: "telegram", enabled: false },
      { category: "warning", channel: "email", enabled: true },
    ]);

    const accepted = await (
      await postEvent(
        baseUrl,
        trigger({
          category: "warning",
          dedupeKey: "SVC-BCAST:warning-sub:1",
        }),
      )
    ).json();

    assert.deepEqual(
      accepted.deliveries.map((delivery) => delivery.channel).sort(),
      ["email", "web"],
    );
    assert.equal(accepted.skipped_channels.includes("telegram"), true);
  });

  it("isolates notifications across tenants", async () => {
    await postEvent(baseUrl, trigger({ dedupeKey: "SVC-BCAST:iso:own" }));

    const otherOrgResponse = await fetch(
      `${baseUrl}/api/v1/notifications?category=critical`,
      {
        headers: headers({
          "x-bridge-organization-id": "org-other",
          "x-request-id": "req-iso",
        }),
      },
    );
    const otherList = await otherOrgResponse.json();

    assert.equal(otherList.items.length, 0);
  });

  it("serves the notifications list within the ≤1s NFR budget", async () => {
    const started = process.hrtime.bigint();
    const response = await fetch(
      `${baseUrl}/api/v1/notifications?category=critical&limit=50`,
      { headers: headers({ "x-request-id": "req-nfr" }) },
    );
    await response.json();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(response.status, 200);
    assert.ok(elapsedMs < 1000, `list took ${elapsedMs}ms, expected < 1000ms`);
  });

  it("exposes delivery and dedup counters on /metrics", async () => {
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();

    assert.match(metrics, /notification_platform_mock_producer_event_total \d+/);
    assert.match(metrics, /notification_platform_mock_duplicate_total \d+/);
    assert.match(metrics, /notification_platform_mock_delivery_total\{channel="web"\} \d+/);
    assert.match(
      metrics,
      /notification_platform_mock_delivery_total\{channel="telegram"\} \d+/,
    );
    assert.match(metrics, /notification_platform_mock_delivery_skipped_total \d+/);
  });
});

describe("Notification Platform delivery degradation over HTTP (M5)", () => {
  it("returns 202 and delivers through Web when Telegram is unavailable", async () => {
    const telegram = failingChannelAdapter("telegram", "telegram provider is down");
    const channels = {
      ...createDefaultChannelAdapters({ now: fixedNow }),
      telegram,
    };
    const notifications = createDeterministicNotificationMock({
      now: fixedNow,
      channels,
    });
    const server = createNotificationPlatformServer({ notifications, now: fixedNow });
    const baseUrl = await listen(server);

    try {
      const response = await postEvent(
        baseUrl,
        trigger({ dedupeKey: "SVC-BCAST:degradation-http:1" }),
      );
      const accepted = await response.json();

      assert.equal(response.status, 202);
      assert.equal(accepted.degraded, true);
      assert.deepEqual(
        accepted.deliveries
          .filter((delivery) => delivery.status === "sent")
          .map((delivery) => delivery.channel),
        ["web"],
      );
      assert.deepEqual(
        accepted.failed_deliveries.map((delivery) => ({
          channel: delivery.channel,
          attempts: delivery.attempts,
        })),
        [{ channel: "telegram", attempts: 3 }],
      );
      assert.equal(telegram.getAttempts(), 3);
      assert.equal(
        validateNotificationCreatedEvent(accepted.notification_created_event).valid,
        true,
      );

      const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
      assert.match(
        metrics,
        /notification_platform_mock_delivery_failed_total\{channel="telegram"\} 1/,
      );
      assert.match(metrics, /notification_platform_mock_delivery_retry_total 2/);
    } finally {
      await close(server);
    }
  });
});
