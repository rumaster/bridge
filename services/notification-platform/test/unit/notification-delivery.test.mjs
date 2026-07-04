import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  createNotificationTriggerEvent,
} from "../../../../packages/contracts/src/c10.mjs";
import { createDefaultChannelAdapters } from "../../src/channel-adapters.mjs";
import { createDeterministicNotificationMock } from "../../src/deterministic-notification.mjs";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-1";
const USER = "manager-1";

function triggerEvent(overrides = {}) {
  return createNotificationTriggerEvent({
    eventId: "evt-1",
    producerServiceId: "SVC-CORE",
    producerEventId: "message-1:created",
    organizationId: ORG,
    recipientUserId: USER,
    category: "critical",
    title: "New priority message",
    body: "Client sent a priority message.",
    payload: { conversation_id: "conversation-1" },
    dedupeKey: "SVC-CORE:message-1:manager-1",
    occurredAt: fixedNow(),
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    requestId: "req-1",
    organizationId: ORG,
    userId: USER,
    ...overrides,
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

function settingsPatch(overrides) {
  return {
    contract: "C10.UpdateNotificationSettingsRequest",
    version: "1.0.0",
    request_id: "req-settings",
    organization_id: ORG,
    user_id: USER,
    settings: overrides,
  };
}

describe("notification domain: producer event acceptance", () => {
  it("creates a notification and delivers to eligible ∩ enabled channels", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    const result = mock.acceptProducerEvent(triggerEvent());

    assert.equal(result.accepted, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.notification.category, "critical");
    // Default-подписки включают web+telegram ⇒ email/push пропущены.
    assert.deepEqual(result.notification.channels, ["web", "telegram"]);
    assert.deepEqual(result.skipped_channels, ["email", "push"]);
    assert.deepEqual(
      result.deliveries.map((delivery) => delivery.channel),
      ["web", "telegram"],
    );
    assert.equal(result.notification_created_event.event, "notification.created");
  });

  it("carries the producer identifiers into the notification payload", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    const result = mock.acceptProducerEvent(triggerEvent());

    assert.equal(result.notification.payload.producer_service_id, "SVC-CORE");
    assert.equal(
      result.notification.payload.producer_event_id,
      "message-1:created",
    );
    assert.equal(result.notification.payload.conversation_id, "conversation-1");
  });

  it("deduplicates the same logical event without a second delivery", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    const first = mock.acceptProducerEvent(triggerEvent());
    const second = mock.acceptProducerEvent(
      triggerEvent({ eventId: "evt-1-retry", producerEventId: "message-1:created-retry" }),
    );

    assert.equal(second.duplicate, true);
    assert.equal(second.notification.id, first.notification.id);

    const list = mock.listNotifications(context(), { category: "critical" });
    assert.equal(list.items.length, 1);

    const metrics = mock.getMetrics();
    assert.equal(metrics.producer_event_total, 2);
    assert.equal(metrics.duplicate_total, 1);
    // Доставка выполнена ровно один раз (web+telegram).
    assert.equal(metrics.delivery_web_total, 1);
    assert.equal(metrics.delivery_telegram_total, 1);
  });

  it("respects disabled subscriptions and skips those channels", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    mock.updateNotificationSettings(
      context(),
      settingsPatch([
        { category: "critical", channel: "web", enabled: true },
        { category: "critical", channel: "telegram", enabled: false },
      ]),
    );

    const result = mock.acceptProducerEvent(triggerEvent());

    assert.deepEqual(result.notification.channels, ["web"]);
    assert.deepEqual(
      result.deliveries.map((delivery) => delivery.channel),
      ["web"],
    );
    assert.ok(result.skipped_channels.includes("telegram"));
    assert.ok(result.skipped_channels.includes("email"));
    assert.ok(result.skipped_channels.includes("push"));
  });

  it("delivers to email/push when the user enables them for a severe category", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    mock.updateNotificationSettings(
      context(),
      settingsPatch([
        { category: "error", channel: "web", enabled: true },
        { category: "error", channel: "email", enabled: true },
        { category: "error", channel: "push", enabled: true },
      ]),
    );

    const result = mock.acceptProducerEvent(triggerEvent({ category: "error" }));

    assert.deepEqual(
      result.deliveries.map((delivery) => delivery.channel).sort(),
      ["email", "push", "telegram", "web"],
    );
    assert.ok(result.deliveries.some((d) => d.provider === "smtp-gateway"));
    assert.ok(result.deliveries.some((d) => d.provider === "push-gateway"));
  });

  it("keeps notifications isolated per tenant/recipient", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    mock.acceptProducerEvent(triggerEvent());
    mock.acceptProducerEvent(
      triggerEvent({
        organizationId: "org-2",
        dedupeKey: "SVC-CORE:message-1:other",
      }),
    );

    const own = mock.listNotifications(context(), {});
    const other = mock.listNotifications(context({ organizationId: "org-2" }), {});

    assert.equal(own.items.every((item) => item.organization_id === ORG), true);
    assert.equal(
      other.items.every((item) => item.organization_id === "org-2"),
      true,
    );
    assert.notEqual(own.items.length, 0);
    assert.notEqual(other.items.length, 0);
  });

  it("falls back to the web channel when no subscription is enabled (schema needs a channel)", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    mock.updateNotificationSettings(
      context(),
      settingsPatch([
        { category: "critical", channel: "web", enabled: false },
        { category: "critical", channel: "telegram", enabled: false },
      ]),
    );

    const result = mock.acceptProducerEvent(triggerEvent());

    // Ни один канал не включён: уведомление всё равно хранится (channels=["web"]),
    // но фактических доставок нет.
    assert.deepEqual(result.notification.channels, ["web"]);
    assert.equal(result.deliveries.length, 0);
  });

  it("updates settings at category × channel granularity without dropping defaults", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    const response = mock.updateNotificationSettings(
      context(),
      settingsPatch([{ category: "critical", channel: "email", enabled: true }]),
    );

    assert.equal(
      response.settings.length,
      NOTIFICATION_CATEGORIES.length * NOTIFICATION_CHANNELS.length,
    );
    assert.equal(
      response.settings.find(
        (setting) => setting.category === "critical" && setting.channel === "email",
      )?.enabled,
      true,
    );
    assert.equal(
      response.settings.find(
        (setting) => setting.category === "critical" && setting.channel === "web",
      )?.enabled,
      true,
    );

    const info = mock.acceptProducerEvent(
      triggerEvent({
        category: "info",
        dedupeKey: "SVC-CORE:message-settings:manager-1",
      }),
    );
    assert.deepEqual(
      info.deliveries.map((delivery) => delivery.channel),
      ["web", "telegram"],
    );
  });

  it("degrades predictably when one channel fails and still delivers to available channels", () => {
    const telegram = failingChannelAdapter("telegram", "telegram provider is down");
    const channels = {
      ...createDefaultChannelAdapters({ now: fixedNow }),
      telegram,
    };
    const mock = createDeterministicNotificationMock({ now: fixedNow, channels });

    const result = mock.acceptProducerEvent(triggerEvent());

    assert.equal(result.degraded, true);
    assert.deepEqual(
      result.deliveries.filter((delivery) => delivery.status === "sent").map((delivery) => delivery.channel),
      ["web"],
    );
    assert.deepEqual(
      result.failed_deliveries.map((delivery) => ({
        channel: delivery.channel,
        status: delivery.status,
        attempts: delivery.attempts,
      })),
      [{ channel: "telegram", status: "failed", attempts: 3 }],
    );
    assert.equal(telegram.getAttempts(), 3);
    assert.equal(result.notification_created_event.event, "notification.created");

    const metrics = mock.getMetrics();
    assert.equal(metrics.delivery_web_total, 1);
    assert.equal(metrics.delivery_telegram_total, 0);
    assert.equal(metrics.delivery_telegram_failed_total, 1);
    assert.equal(metrics.delivery_retry_total, 2);
  });

  it("preserves degraded delivery records for duplicate producer events", () => {
    const telegram = failingChannelAdapter("telegram", "telegram provider is down");
    const channels = {
      ...createDefaultChannelAdapters({ now: fixedNow }),
      telegram,
    };
    const mock = createDeterministicNotificationMock({ now: fixedNow, channels });

    const first = mock.acceptProducerEvent(triggerEvent());
    const duplicate = mock.acceptProducerEvent(triggerEvent());

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.degraded, true);
    assert.deepEqual(
      duplicate.deliveries
        .filter((delivery) => delivery.status === "sent")
        .map((delivery) => delivery.channel),
      ["web"],
    );
    assert.deepEqual(
      duplicate.failed_deliveries.map((delivery) => ({
        channel: delivery.channel,
        status: delivery.status,
        attempts: delivery.attempts,
      })),
      [{ channel: "telegram", status: "failed", attempts: 3 }],
    );
    assert.equal(telegram.getAttempts(), 3);
  });

  it("uses the priority retry policy for admin notifications and sends them via remaining channels", () => {
    const telegram = failingChannelAdapter("telegram", "telegram provider is down");
    const channels = {
      ...createDefaultChannelAdapters({ now: fixedNow }),
      telegram,
    };
    const mock = createDeterministicNotificationMock({ now: fixedNow, channels });
    mock.updateNotificationSettings(
      context(),
      settingsPatch([
        { category: "admin", channel: "web", enabled: true },
        { category: "admin", channel: "telegram", enabled: true },
        { category: "admin", channel: "email", enabled: true },
      ]),
    );

    const result = mock.acceptProducerEvent(
      triggerEvent({
        producerServiceId: "SVC-IDN",
        producerEventId: "administrator-1:created",
        category: "admin",
        title: "Administrator account changed",
        body: "Administrative notification.",
        dedupeKey: "SVC-IDN:administrator-1:manager-1",
      }),
    );

    assert.deepEqual(
      result.deliveries.filter((delivery) => delivery.status === "sent").map((delivery) => delivery.channel),
      ["web", "email"],
    );
    assert.deepEqual(result.failed_deliveries.map((delivery) => delivery.channel), [
      "telegram",
    ]);
    assert.equal(result.failed_deliveries[0].attempts, 3);
  });
});

describe("notification domain: listing and NFR pagination", () => {
  function seed(mock, count) {
    for (let index = 0; index < count; index += 1) {
      mock.acceptProducerEvent(
        triggerEvent({
          eventId: `evt-${index}`,
          producerEventId: `message-${index}`,
          dedupeKey: `SVC-CORE:message-${index}:manager-1`,
        }),
      );
    }
  }

  it("paginates newest-first with an opaque cursor", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    seed(mock, 5);

    const firstPage = mock.listNotifications(context(), { category: "critical", limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.page.next_cursor);

    const secondPage = mock.listNotifications(context(), {
      category: "critical",
      limit: 2,
      cursor: firstPage.page.next_cursor,
    });
    assert.equal(secondPage.items.length, 2);

    const firstIds = firstPage.items.map((item) => item.id);
    const secondIds = secondPage.items.map((item) => item.id);
    assert.equal(firstIds.some((id) => secondIds.includes(id)), false);
  });

  it("serves list requests well within the ≤1s NFR budget", () => {
    const mock = createDeterministicNotificationMock({ now: fixedNow });
    seed(mock, 200);

    const started = process.hrtime.bigint();
    const list = mock.listNotifications(context(), { category: "critical", limit: 50 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(list.items.length, 50);
    assert.ok(elapsedMs < 1000, `list took ${elapsedMs}ms, expected < 1000ms`);
  });
});
