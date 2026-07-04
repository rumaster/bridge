import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  createBackendM1Modules,
  createBackendServer,
} from "../../src/main.mjs";
import {
  createIdentityService,
  createMockTelegramCodeDeliveryAdapter,
} from "../../src/modules/identity/identity-service.mjs";

describe("backend skeleton with M1 AuthGuard", () => {
  let server;
  let baseUrl;

  before(async () => {
    const identityService = createIdentityService({
      codeGenerator: () => "123456",
      deliveryAdapter: createMockTelegramCodeDeliveryAdapter(),
      hashSecret: "backend-integration-secret",
      now: () => new Date("2026-07-03T10:00:00.000Z"),
    });

    server = createBackendServer({
      modules: createBackendM1Modules({ identityService }),
    });
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

  it("rejects GET /api/v1/auth/session without a server session", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/session`);

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("content-type"), "application/json");

    const body = await response.json();
    assert.equal(body.title, "Unauthorized");
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
    assert.deepEqual(body.contracts, [
      "C3.base",
      "C3.auth",
      "C3.platform",
      "C3.users",
      "C1",
      "C2",
    ]);
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

  it("serves POST /api/v1/auth/login/telegram/start as an M1 challenge", async () => {
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
    assert.equal(body.status, "code_delivery_scheduled");
    assert.equal(body.telegramUsername, "seeded_admin");
    assert.equal(body.implementationStage, "M1");
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  });

  it("serves POST /api/v1/auth/login/telegram/verify and reads the current session", async () => {
    const start = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          telegramUsername: "seeded_admin",
        }),
      },
    );
    const challenge = await start.json();
    const response = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: challenge.requestId,
          code: "123456",
        }),
      },
    );

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.session.mode, "server");
    assert.match(body.token, /^brs_/);
    assert.equal(response.headers.get("set-cookie").includes("bridge_session="), true);

    const sessionResponse = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: {
        authorization: `Bearer ${body.token}`,
      },
    });
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionBody.user.telegramUsername, "seeded_admin");
    assert.deepEqual(sessionBody.roles, ["administrator"]);
  });

  it("serves POST /api/v1/auth/logout through M1 AuthGuard", async () => {
    const start = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          telegramUsername: "seeded_admin",
        }),
      },
    );
    const challenge = await start.json();
    const verify = await fetch(
      `${baseUrl}/api/v1/auth/login/telegram/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: challenge.requestId,
          code: "123456",
        }),
      },
    );
    const session = await verify.json();
    const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.loggedOut, true);
    assert.equal(body.sessionMode, "server");

    const afterLogout = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: {
        authorization: `Bearer ${session.token}`,
      },
    });
    assert.equal(afterLogout.status, 401);
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
