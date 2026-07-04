import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeviceRegistry } from "../../src/device-registry.mjs";
import { createPushDispatcher } from "../../src/push-dispatcher.mjs";
import { createMockPushProvider } from "../../src/push-provider.mjs";

let clock = 0;
const now = () => `2026-07-04T12:00:00.${String(clock++).padStart(3, "0")}Z`;

function mobileNotification(overrides = {}) {
  return {
    notification_id: "notification-1",
    organization_id: "org-1",
    user_id: "manager-1",
    title: "Escalation",
    body: "A client is waiting",
    severity: "critical",
    data: { conversation_id: "conversation-1" },
    created_at: "2026-07-04T12:00:00.000Z",
    read_at: null,
    ...overrides,
  };
}

function harness(providerOptions = {}) {
  clock = 0;
  const registry = createDeviceRegistry({ now });
  registry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "device-1",
    platform: "android",
    pushProvider: "fcm",
    pushToken: "token-1",
  });
  const provider = createMockPushProvider({ now, ...providerOptions });
  const dispatcher = createPushDispatcher({ provider, registry });
  return { registry, provider, dispatcher };
}

describe("SVC-MOB push-dispatcher (§19.4, §15.4)", () => {
  it("delivers on the first attempt when the provider is healthy", () => {
    const { dispatcher } = harness();
    const { results } = dispatcher.dispatchToUser("manager-1", mobileNotification());
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "delivered");
    assert.equal(results[0].attempts, 1);
    assert.equal(dispatcher.getMetrics().push_delivered_total, 1);
  });

  it("retries transient provider failures and eventually delivers", () => {
    const { dispatcher } = harness({ transientTokens: ["token-1", "token-1"] });
    const { results } = dispatcher.dispatchToUser("manager-1", mobileNotification());
    assert.equal(results[0].status, "delivered");
    assert.equal(results[0].attempts, 3);
    assert.equal(dispatcher.getMetrics().push_retry_total, 2);
    assert.equal(dispatcher.getMetrics().push_delivered_total, 1);
  });

  it("gives up after maxAttempts when the provider stays unavailable", () => {
    const { dispatcher } = harness({ transientTokens: ["token-1", "token-1", "token-1"] });
    const { results } = dispatcher.dispatchToUser("manager-1", mobileNotification());
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].attempts, 3);
    assert.equal(dispatcher.getMetrics().push_failed_total, 1);
  });

  it("deactivates a dead token and stops targeting the device", () => {
    const { dispatcher, registry } = harness({ deadTokens: ["token-1"] });
    const { results } = dispatcher.dispatchToUser("manager-1", mobileNotification());
    assert.equal(results[0].status, "deactivated");
    assert.equal(results[0].reason, "token_unregistered");
    assert.equal(registry.get("device-1").active, false);
    assert.equal(dispatcher.getMetrics().push_token_deactivated_total, 1);

    // Последующая доставка уже не находит активных устройств.
    const followUp = dispatcher.dispatchToUser("manager-1", mobileNotification());
    assert.deepEqual(followUp.results, []);
    assert.equal(dispatcher.getMetrics().push_no_device_total, 1);
  });

  it("does not deliver across tenants (organization isolation)", () => {
    const { dispatcher, provider } = harness();
    const foreign = mobileNotification({ organization_id: "org-2" });
    const { results } = dispatcher.dispatchToUser("manager-1", foreign);
    assert.deepEqual(results, []);
    assert.equal(dispatcher.getMetrics().push_no_device_total, 1);
    assert.equal(provider.getMetrics().send_total, 0, "provider is never called for a foreign tenant");
  });

  it("normalizes a raw C10 notification before mapping it to a push payload", () => {
    const { dispatcher } = harness();
    const rawC10 = {
      id: "notification-9",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "warning",
      title: "Raw",
      body: "From C10",
      payload: { conversation_id: "conversation-1" },
      status: "new",
      created_at: "2026-07-04T12:00:00.000Z",
      read_at: null,
    };
    const { notification_id, results } = dispatcher.dispatchToUser("manager-1", rawC10);
    assert.equal(notification_id, "notification-9");
    assert.equal(results[0].status, "delivered");
  });

  it("reports no-device when the user has no registered devices", () => {
    const { dispatcher } = harness();
    const { results } = dispatcher.dispatchToUser("nobody", mobileNotification({ user_id: "nobody" }));
    assert.deepEqual(results, []);
    assert.equal(dispatcher.getMetrics().push_no_device_total, 1);
  });
});
