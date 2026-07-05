import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createNotificationPlatformServer } from "../../src/server.js";

describe("Notification Platform deterministic mock server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createNotificationPlatformServer({
      now: () => "2026-07-02T16:31:00.000Z",
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://${address.address}:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("starts and exposes health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "notification-platform",
      mode: "deterministic-mock",
      contract: "C10",
    });
  });

  it("serves C10 notification list and read acknowledgement", async () => {
    const listResponse = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: {
        "x-request-id": "req-list-1",
        "x-bridge-organization-id": "org-1",
        "x-bridge-user-id": "manager-1",
      },
    });

    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.contract, "C10.ListNotificationsResponse");
    assert.equal(list.items.length, 1);

    const readResponse = await fetch(
      `${baseUrl}/api/v1/notifications/${list.items[0].id}:read`,
      {
        method: "POST",
        headers: {
          "x-request-id": "req-read-1",
          "x-bridge-organization-id": "org-1",
          "x-bridge-user-id": "manager-1",
        },
      },
    );

    assert.equal(readResponse.status, 200);
    const read = await readResponse.json();
    assert.equal(read.notification.status, "read");
    assert.equal(read.notification.read_at, "2026-07-02T16:31:00.000Z");
  });

  it("returns validation errors for settings context mismatches", async () => {
    const response = await fetch(`${baseUrl}/api/v1/notifications/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-bridge-organization-id": "org-1",
        "x-bridge-user-id": "manager-1",
      },
      body: JSON.stringify({
        contract: "C10.UpdateNotificationSettingsRequest",
        version: "1.0.0",
        request_id: "req-settings-context-1",
        organization_id: "other-org",
        user_id: "other-user",
        settings: [
          {
            category: "critical",
            channel: "web",
            enabled: true,
          },
        ],
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.title, "Validation failed");
    assert.match(body.errors.map((error) => error.field).join(","), /organization_id/);
  });
});
