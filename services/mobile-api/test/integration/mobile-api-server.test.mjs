import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createMobileApiServer } from "../../src/server.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-02T16:30:00.000Z";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Mobile API deterministic mock server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createMobileApiServer({ now: fixedNow });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("starts and exposes health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "mobile-api",
      mode: "deterministic-mock",
      contract: "MOBILE.v1",
      base_path: "/mobile/v1",
    });
  });

  it("serves aggregated dialogs, messages and notifications", async () => {
    const dialogs = await fetch(`${baseUrl}/mobile/v1/dialogs`);
    const messages = await fetch(`${baseUrl}/mobile/v1/dialogs/dialog-1/messages`);
    const notifications = await fetch(`${baseUrl}/mobile/v1/notifications`);

    assert.equal(dialogs.status, 200);
    assert.equal(messages.status, 200);
    assert.equal(notifications.status, 200);
    assert.equal((await dialogs.json()).items[0].dialog_id, "dialog-1");
    assert.equal((await messages.json()).items.length, 2);
    assert.equal((await notifications.json()).items[0].notification_id, "notification-1");
  });

  it("serves sync cursors and empty follow-up deltas", async () => {
    const firstResponse = await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1`);
    const first = await firstResponse.json();
    const secondResponse = await fetch(
      `${baseUrl}/mobile/v1/sync?device_id=device-1&cursor=${encodeURIComponent(first.cursor)}`,
    );
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.match(first.cursor, /^mob1\.[A-Za-z0-9_-]+$/);
    assert.equal(first.deltas.dialogs.length, 1);
    assert.equal(secondResponse.status, 200);
    assert.equal(second.previous_cursor, first.cursor);
    assert.deepEqual(second.deltas.dialogs, []);
  });

  it("registers devices and returns push mapping stubs", async () => {
    const response = await fetch(`${baseUrl}/mobile/v1/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "MOBILE.RegisterDeviceRequest",
        version: "1.0.0",
        request_id: "req-device-1",
        organization_id: "org-1",
        user_id: "manager-1",
        device_id: "device-1",
        platform: "android",
        push_provider: "fcm",
        push_token: "fcm-token-1",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.device.device_id, "device-1");
    assert.equal(body.push_payload_stub.provider, "fcm");
  });

  it("accepts idempotent mobile sends and rejects invalid DTOs", async () => {
    const valid = await fetch(`${baseUrl}/mobile/v1/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "MOBILE.SendMessageRequest",
        version: "1.0.0",
        request_id: "req-message-1",
        organization_id: "org-1",
        conversation_id: "conversation-1",
        message_id: "message-1",
        idempotency_key: "message-1",
        sender_user_id: "manager-1",
        text: "Hello",
      }),
    });
    const invalid = await fetch(`${baseUrl}/mobile/v1/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "MOBILE.SendMessageRequest",
        version: "1.0.0",
        request_id: "req-message-1",
        organization_id: "org-1",
        conversation_id: "conversation-1",
        message_id: "message-1",
        idempotency_key: "different",
        sender_user_id: "manager-1",
        text: "Hello",
      }),
    });

    assert.equal(valid.status, 202);
    assert.equal((await valid.json()).proxied_to, "C3.messages");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).title, "Validation failed");
  });
});
