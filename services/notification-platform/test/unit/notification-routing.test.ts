import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NOTIFICATION_CATEGORY_CHANNELS,
  PRODUCER_DEFAULT_CATEGORY,
  deliveryPolicyForCategory,
  eligibleChannelsForCategory,
  isPriorityNotificationCategory,
  isSupportedChannel,
  resolveTargetChannels,
  routeProducerEvent,
} from "../../src/notification-routing.js";

describe("notification routing (M3/M4)", () => {
  it("keeps the explicit event category over the producer default", () => {
    const route = routeProducerEvent({
      producer_service_id: "SVC-CORE",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "critical",
    });

    assert.equal(route.category, "critical");
    assert.equal(route.recipient_user_id, "manager-1");
    assert.equal(route.organization_id, "org-1");
    assert.equal(route.producer_service_id, "SVC-CORE");
  });

  it("falls back to the producer default category when the event omits one", () => {
    for (const [producer, expected] of Object.entries(PRODUCER_DEFAULT_CATEGORY)) {
      const route = routeProducerEvent({
        producer_service_id: producer,
        organization_id: "org-1",
        recipient_user_id: "manager-1",
      });
      assert.equal(route.category, expected, `producer ${producer}`);
    }
  });

  it("defaults unknown producers to the info category", () => {
    const route = routeProducerEvent({
      producer_service_id: "SVC-UNKNOWN",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
    });

    assert.equal(route.category, "info");
  });

  it("maps categories to eligible channels with more channels for severe categories", () => {
    assert.deepEqual(eligibleChannelsForCategory("info"), ["web", "telegram"]);
    assert.deepEqual(eligibleChannelsForCategory("warning"), [
      "web",
      "telegram",
      "email",
    ]);
    assert.deepEqual(eligibleChannelsForCategory("error"), [
      "web",
      "telegram",
      "email",
      "push",
    ]);
    assert.deepEqual(eligibleChannelsForCategory("critical"), [
      "web",
      "telegram",
      "email",
      "push",
    ]);
    assert.deepEqual(eligibleChannelsForCategory("admin"), [
      "web",
      "telegram",
      "email",
    ]);
  });

  it("exposes eligible channels on the route result", () => {
    const route = routeProducerEvent({
      producer_service_id: "SVC-BCAST",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "error",
    });

    assert.deepEqual(route.eligible_channels, ["web", "telegram", "email", "push"]);
  });

  it("returns a defensive copy of the eligible channels", () => {
    const first = eligibleChannelsForCategory("info");
    first.push("push");
    assert.deepEqual(eligibleChannelsForCategory("info"), ["web", "telegram"]);
    assert.deepEqual(NOTIFICATION_CATEGORY_CHANNELS.info, ["web", "telegram"]);
  });

  it("resolves target channels as eligible ∩ enabled subscriptions", () => {
    const settings = [
      { category: "warning", channel: "web", enabled: true },
      { category: "warning", channel: "telegram", enabled: false },
      { category: "warning", channel: "email", enabled: true },
      { category: "info", channel: "web", enabled: true },
    ];

    assert.deepEqual(resolveTargetChannels({ category: "warning", settings }), [
      "web",
      "email",
    ]);
  });

  it("excludes channels that are not eligible for the category even if enabled", () => {
    const settings = [
      { category: "info", channel: "web", enabled: true },
      { category: "info", channel: "email", enabled: true },
      { category: "info", channel: "push", enabled: true },
    ];

    // email/push не входят в eligible(info) ⇒ доставка только в web.
    assert.deepEqual(resolveTargetChannels({ category: "info", settings }), ["web"]);
  });

  it("returns no target channels when every subscription is disabled", () => {
    const settings = [
      { category: "critical", channel: "web", enabled: false },
      { category: "critical", channel: "telegram", enabled: false },
    ];

    assert.deepEqual(resolveTargetChannels({ category: "critical", settings }), []);
  });

  it("recognises supported channels only", () => {
    assert.equal(isSupportedChannel("web"), true);
    assert.equal(isSupportedChannel("telegram"), true);
    assert.equal(isSupportedChannel("email"), true);
    assert.equal(isSupportedChannel("push"), true);
    assert.equal(isSupportedChannel("sms"), false);
  });

  it("prioritises critical and admin categories with the strongest retry policy", () => {
    assert.equal(isPriorityNotificationCategory("critical"), true);
    assert.equal(isPriorityNotificationCategory("admin"), true);
    assert.equal(isPriorityNotificationCategory("warning"), false);

    assert.equal(deliveryPolicyForCategory("critical").max_attempts, 3);
    assert.equal(deliveryPolicyForCategory("admin").max_attempts, 3);
    assert.equal(deliveryPolicyForCategory("warning").max_attempts, 1);
  });

  it("rejects non-object producer events", () => {
    assert.throws(() => routeProducerEvent(null), TypeError);
    assert.throws(() => routeProducerEvent("event"), TypeError);
  });
});
