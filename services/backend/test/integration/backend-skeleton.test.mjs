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
});
