import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeviceRegistry } from "../../src/device-registry.mjs";

let clock = 0;
const now = () => `2026-07-04T12:00:00.${String(clock++).padStart(3, "0")}Z`;

function register(registry, overrides = {}) {
  return registry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "device-1",
    platform: "android",
    pushProvider: "fcm",
    pushToken: "token-1",
    appVersion: "1.0.0",
    locale: "ru-RU",
    ...overrides,
  });
}

describe("SVC-MOB device-registry (§19.4)", () => {
  it("registers an active device with a created_at timestamp", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    const device = register(registry);
    assert.equal(device.active, true);
    assert.equal(device.revoked_at, null);
    assert.equal(device.online, false);
    assert.ok(device.created_at);
    assert.equal(registry.getMetrics().registered_total, 1);
  });

  it("preserves created_at and online presence when re-registering a token", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    const initial = register(registry);
    registry.markOnline("device-1");

    const rotated = register(registry, { pushToken: "token-2" });
    assert.equal(rotated.created_at, initial.created_at, "created_at is stable across re-register");
    assert.equal(rotated.online, true, "online presence is preserved");
    assert.equal(rotated.push_token, "token-2", "the push token is rotated");
  });

  it("deactivates a dead token and drops it from the active set", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    register(registry);
    const deactivated = registry.deactivate("device-1", "token_unregistered");

    assert.equal(deactivated.active, false);
    assert.equal(deactivated.deactivated_reason, "token_unregistered");
    assert.deepEqual(registry.getActiveDevices("manager-1"), []);
    assert.equal(registry.hasOnlineDevice("manager-1"), false);
    assert.equal(registry.getMetrics().deactivated_total, 1);
  });

  it("returns null when deactivating an unknown device", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    assert.equal(registry.deactivate("ghost"), null);
  });

  it("revokes a device and excludes it from active devices", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    register(registry);
    const revoked = registry.revoke("device-1");
    assert.equal(revoked.active, false);
    assert.ok(revoked.revoked_at);
    assert.deepEqual(registry.getActiveDevices("manager-1"), []);
  });

  it("synthesizes a revocation record for an unknown device", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    const revoked = registry.revoke("device-unknown");
    assert.equal(revoked.device_id, "device-unknown");
    assert.equal(revoked.active, false);
    assert.ok(revoked.revoked_at);
  });

  it("tracks online presence for the WS→push fallback", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    register(registry);
    assert.equal(registry.hasOnlineDevice("manager-1"), false);

    registry.markOnline("device-1");
    assert.equal(registry.hasOnlineDevice("manager-1"), true);

    registry.markOffline("device-1");
    assert.equal(registry.hasOnlineDevice("manager-1"), false);
  });

  it("cannot bring a revoked device back online", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    register(registry);
    registry.revoke("device-1");
    assert.equal(registry.markOnline("device-1"), null);
    assert.equal(registry.hasOnlineDevice("manager-1"), false);
  });

  it("scopes active devices to the requested user", () => {
    clock = 0;
    const registry = createDeviceRegistry({ now });
    register(registry);
    register(registry, { deviceId: "device-2", userId: "manager-2", pushToken: "token-2" });

    assert.deepEqual(
      registry.getActiveDevices("manager-1").map((d) => d.device_id),
      ["device-1"],
    );
    assert.deepEqual(
      registry.getActiveDevices("manager-2").map((d) => d.device_id),
      ["device-2"],
    );
  });
});
