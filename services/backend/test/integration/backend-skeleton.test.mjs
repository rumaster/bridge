import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createBackendServer } from "../../src/main.mjs";

describe("backend skeleton with mock AuthGuard", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createBackendServer();
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves GET /api/v1/auth/session with seeded identity", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/session`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");

    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.telegramUsername, "seeded_admin");
    assert.deepEqual(body.roles, ["administrator"]);
  });

  it("reports CORE/IDN/API modules and degraded external facades from health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.deepEqual(body.modules, [
      "backend-api",
      "identity",
      "communication-core",
    ]);
    assert.deepEqual(body.contracts, ["C3.base", "C3.auth", "C1", "C2"]);
    assert.deepEqual(
      body.externalFacades.map((facade) => [facade.serviceId, facade.mode]),
      [
        ["SVC-AI", "mock"],
        ["SVC-FBP", "mock"],
        ["SVC-BCAST", "mock"],
        ["SVC-NOTIF", "mock"],
        ["SVC-INT", "mock"],
      ],
    );
  });

  it("serves POST /api/v1/auth/login/telegram/start as an M0 stub", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          telegramUsername: "@Seeded_Admin",
        }),
      },
    );

    assert.equal(response.status, 202);

    const body = await response.json();
    assert.equal(body.status, "mock_code_delivery_scheduled");
    assert.equal(body.telegramUsername, "seeded_admin");
    assert.equal(body.implementationStage, "M0");
  });

  it("serves POST /api/v1/auth/login/telegram/verify as an M0 stub", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          telegramUsername: "seeded_admin",
          code: "123456",
        }),
      },
    );

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.session.mode, "mock");
  });

  it("serves POST /api/v1/auth/logout through mock AuthGuard", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.loggedOut, true);
    assert.equal(body.sessionMode, "mock");
  });

  it("returns ProblemDetails for DTO validation errors", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          telegramUsername: "seeded_admin",
          code: "wrong",
        }),
      },
    );

    assert.equal(response.status, 400);

    const body = await response.json();
    assert.equal(body.title, "Validation failed");
    assert.equal(body.errors[0].field, "code");
  });

  it("accepts and routes a valid C2 ingress message through Communication Core M1", async () => {
    const response = await fetch(`${baseUrl}/api/v1/internal/ingress/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        endpoint_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        channel: "web_chat",
        direction: "inbound",
        sender_type: "client",
        sequence_number: 7,
        type: "text",
        content: {
          text: "Need help",
        },
        status: "received",
        created_at: "2026-07-02T16:05:00.000Z",
        updated_at: "2026-07-02T16:05:00.000Z",
      }),
    });

    assert.equal(response.status, 202);

    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.message_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(body.status, "routed");
    assert.equal(body.routed_to, "manager");
  });
});
