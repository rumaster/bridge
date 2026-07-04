import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateNotificationCreatedEvent } from "../../../../packages/contracts/src/c10.mjs";
import {
  createDefaultChannelAdapters,
  createEmailChannelAdapter,
  createPushChannelAdapter,
  createTelegramChannelAdapter,
  createWebChannelAdapter,
} from "../../src/channel-adapters.mjs";

const fixedNow = () => "2026-07-04T09:30:00.000Z";

function notification(overrides = {}) {
  return {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notification-1",
    organization_id: "org-1",
    recipient_user_id: "manager-1",
    category: "critical",
    title: "Title",
    body: "Body",
    payload: {},
    status: "new",
    channels: ["web", "telegram"],
    created_at: "2026-07-04T09:30:00.000Z",
    read_at: null,
    ...overrides,
  };
}

describe("channel adapters (M3/M4 delivery)", () => {
  it("builds a valid C7 notification.created event on the web channel", () => {
    const adapter = createWebChannelAdapter({ now: fixedNow });
    const record = adapter.deliver({ notification: notification() });

    assert.equal(record.channel, "web");
    assert.equal(record.status, "sent");
    assert.equal(record.provider, "svc-edge-ws");
    assert.equal(record.provider_ref, "ws:notification-1");
    assert.equal(record.dispatched_at, "2026-07-04T09:30:00.000Z");
    assert.equal(record.event.event, "notification.created");
    assert.equal(validateNotificationCreatedEvent(record.event).valid, true);
  });

  it("records dispatched web events for inspection", () => {
    const adapter = createWebChannelAdapter({ now: fixedNow });
    adapter.deliver({ notification: notification() });
    adapter.deliver({ notification: notification({ id: "notification-2" }) });

    const dispatches = adapter.getDispatches();
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].event_id, "notification-2:created");
  });

  it("delivers telegram/email/push through recording provider adapters", () => {
    const cases = [
      { adapter: createTelegramChannelAdapter({ now: fixedNow }), channel: "telegram", provider: "svc-tgc" },
      { adapter: createEmailChannelAdapter({ now: fixedNow }), channel: "email", provider: "smtp-gateway" },
      { adapter: createPushChannelAdapter({ now: fixedNow }), channel: "push", provider: "push-gateway" },
    ];

    for (const { adapter, channel, provider } of cases) {
      const record = adapter.deliver({ notification: notification() });
      assert.equal(record.channel, channel);
      assert.equal(record.status, "sent");
      assert.equal(record.provider, provider);
      assert.equal(record.provider_ref, `${channel}:notification-1`);
      assert.equal(record.dispatched_at, "2026-07-04T09:30:00.000Z");
      assert.equal(record.event, undefined);

      const dispatches = adapter.getDispatches();
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].notification_id, "notification-1");
      assert.equal(dispatches[0].recipient_user_id, "manager-1");
      assert.equal(dispatches[0].category, "critical");
    }
  });

  it("returns the full set of default adapters keyed by channel", () => {
    const adapters = createDefaultChannelAdapters({ now: fixedNow });
    assert.deepEqual(Object.keys(adapters).sort(), [
      "email",
      "push",
      "telegram",
      "web",
    ]);
    assert.equal(adapters.web.channel, "web");
    assert.equal(adapters.telegram.channel, "telegram");
    assert.equal(adapters.email.channel, "email");
    assert.equal(adapters.push.channel, "push");
  });
});
