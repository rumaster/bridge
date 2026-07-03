import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionAuthGuard } from "../../src/common/auth/session-auth-guard.mjs";
import {
  createIdentityService,
  createInMemoryIdentityStore,
  createMockTelegramCodeDeliveryAdapter,
} from "../../src/modules/identity/identity-service.mjs";

async function createAuthenticatedService() {
  const service = createIdentityService({
    codeGenerator: () => "123456",
    deliveryAdapter: createMockTelegramCodeDeliveryAdapter(),
    hashSecret: "guard-test-secret",
    now: () => new Date("2026-07-03T10:00:00.000Z"),
    store: createInMemoryIdentityStore(),
  });
  const start = await service.startTelegramLogin({
    telegramUsername: "seeded_admin",
  });
  const verify = await service.verifyTelegramLogin({
    requestId: start.body.requestId,
    code: "123456",
  });

  return {
    service,
    token: verify.body.token,
  };
}

describe("session AuthGuard", () => {
  it("requires an active Bearer session and attaches auth context", async () => {
    const { service, token } = await createAuthenticatedService();
    const guard = createSessionAuthGuard({ identityService: service });
    const request = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };

    const result = await guard.authorize(request);

    assert.equal(result.ok, true);
    assert.equal(await guard.canActivate(request), true);
    assert.equal(request.auth.user.telegramUsername, "seeded_admin");
    assert.equal(request.auth.session.mode, "server");
  });

  it("accepts the bridge_session cookie when Authorization is absent", async () => {
    const { service, token } = await createAuthenticatedService();
    const guard = createSessionAuthGuard({ identityService: service });
    const request = {
      headers: {
        Cookie: `theme=light; bridge_session=${encodeURIComponent(token)}`,
      },
    };

    const result = await guard.authorize(request);

    assert.equal(result.ok, true);
    assert.equal(request.auth.token, token);
  });

  it("rejects missing or malformed tokens", async () => {
    const { service } = await createAuthenticatedService();
    const guard = createSessionAuthGuard({ identityService: service });

    const result = await guard.authorize({ headers: {} });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("checks organization ownership when request declares tenant scope", async () => {
    const { service, token } = await createAuthenticatedService();
    const guard = createSessionAuthGuard({ identityService: service });
    const request = {
      body: {
        organization_id: "99999999-9999-4999-8999-999999999999",
      },
      headers: {
        authorization: `Bearer ${token}`,
      },
    };

    const result = await guard.authorize(request);

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});
