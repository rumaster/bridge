import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createMobileApiServer } from "../../services/mobile-api/src/server.js";

const root = process.cwd();
const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-02T16:30:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("Mobile app <-> SVC-MOB M5 contract", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createMobileApiServer({ now: fixedNow });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("publishes MOBILE.v1 OpenAPI with independent semver and frozen endpoint set", () => {
    const openApi = readJson("packages/contracts/openapi/mobile/mobile.v1.openapi.json");

    assert.equal(openApi["x-contract-id"], "MOBILE.v1");
    assert.equal(openApi["x-owner"], "SVC-MOB");
    assert.equal(openApi["x-stage"], "M5");
    assert.equal(openApi.info.version, "1.1.0");
    assert.deepEqual(openApi["x-supported-versions"], ["1.0.0", "1.1.0"]);
    assert.deepEqual(openApi.servers, [{ url: "/mobile/v1" }]);
    assert.deepEqual(Object.entries(openApi.paths).map(([path, methods]) => [
      path,
      Object.keys(methods),
    ]), [
      ["/auth/login/telegram/start", ["post"]],
      ["/auth/login/telegram/verify", ["post"]],
      ["/auth/logout", ["post"]],
      ["/auth/session", ["get"]],
      ["/dialogs", ["get"]],
      ["/dialogs/{dialog_id}/messages", ["get"]],
      ["/messages", ["post"]],
      ["/notifications", ["get"]],
      ["/sync", ["get"]],
      ["/devices", ["post"]],
      ["/devices/{device_id}", ["delete"]],
    ]);
  });

  it("publishes mobile app and upstream SVC-MOB consumer stubs", () => {
    const stubs = readJson("packages/contracts/mobile/consumer-contracts.v1.json");
    const appInteractions = stubs.interactions.filter(
      (interaction) => interaction.consumer === "mobile-app" && interaction.provider === "SVC-MOB",
    );
    const upstreamContracts = new Set(
      stubs.interactions
        .filter((interaction) => interaction.consumer === "SVC-MOB")
        .map((interaction) => interaction.upstream_contract),
    );

    assert.equal(stubs.contract, "MOBILE.ConsumerContracts");
    assert.equal(stubs.version, "1.1.0");
    assert.deepEqual(stubs.supported_versions, ["1.0.0", "1.1.0"]);
    assert.ok(appInteractions.length >= 5);
    assert.ok(upstreamContracts.has("C3.auth"));
    assert.ok(upstreamContracts.has("C7"));
    assert.ok(upstreamContracts.has("C9"));
    assert.ok(upstreamContracts.has("C10.notifications"));
  });

  it("smokes the frozen contract against the mobile-api mock provider", async () => {
    const dialogs = await fetch(`${baseUrl}/mobile/v1/dialogs`);
    const sync = await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1`);
    const device = await fetch(`${baseUrl}/mobile/v1/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "MOBILE.RegisterDeviceRequest",
        version: "1.0.0",
        request_id: "req-contract-device-1",
        organization_id: "org-1",
        user_id: "manager-1",
        device_id: "device-1",
        platform: "android",
        push_provider: "fcm",
        push_token: "fcm-token-1",
      }),
    });

    assert.equal(dialogs.status, 200);
    assert.equal(((await dialogs.json()) as any).contract, "MOBILE.DialogListResponse");
    assert.equal(sync.status, 200);
    assert.match(((await sync.json()) as any).cursor, /^mob1\.[A-Za-z0-9_-]+$/);
    assert.equal(device.status, 201);
    assert.equal(((await device.json()) as any).push_payload_stub.contract, "MOBILE.PushPayloadStub");
  });
});
