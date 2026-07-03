import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDENTITY_AUDIT_ACTIONS,
  createIdentityService,
  createInMemoryAuditRecorder,
  createInMemoryIdentityStore,
  createMockTelegramCodeDeliveryAdapter,
} from "../../src/modules/identity/identity-service.mjs";

const BASE_TIME = new Date("2026-07-03T10:00:00.000Z");

function mutableClock(start = BASE_TIME) {
  let current = new Date(start);

  return {
    now: () => new Date(current),
    advanceSeconds(seconds) {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

function createTestService(options = {}) {
  const auditRecorder = options.auditRecorder ?? createInMemoryAuditRecorder();
  const clock = mutableClock();
  const deliveryAdapter = createMockTelegramCodeDeliveryAdapter();
  const store = options.store ?? createInMemoryIdentityStore();
  const service = createIdentityService({
    auditRecorder,
    codeGenerator: () => "123456",
    deliveryAdapter,
    hashSecret: "unit-test-secret",
    now: clock.now,
    store,
    ...options,
  });

  return {
    auditRecorder,
    clock,
    deliveryAdapter,
    service,
    store,
  };
}

describe("identity service M1 Telegram login", () => {
  it("generates a Telegram code, stores only code_hash and schedules mock delivery", async () => {
    const { deliveryAdapter, service, store } = createTestService();

    const response = await service.startTelegramLogin({
      telegramUsername: "@Seeded_Admin",
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.implementationStage, "M1");
    assert.equal(response.body.status, "code_delivery_scheduled");
    assert.match(response.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.body.telegramUsername, "seeded_admin");

    const loginCode = await store.findLoginCodeById(response.body.requestId);
    assert.equal(loginCode.code, undefined);
    assert.notEqual(loginCode.codeHash, "123456");
    assert.match(loginCode.codeHash, /^sha256:/);
    assert.equal(loginCode.consumedAt, null);

    assert.deepEqual(deliveryAdapter.deliveries.map((delivery) => ({
      telegramUsername: delivery.telegramUsername,
      code: delivery.code,
      purpose: delivery.purpose,
    })), [
      {
        telegramUsername: "seeded_admin",
        code: "123456",
        purpose: "telegram_login",
      },
    ]);
  });

  it("rejects unknown Telegram users without delivering a code", async () => {
    const { deliveryAdapter, service } = createTestService();

    const response = await service.startTelegramLogin({
      telegramUsername: "missing_user",
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.title, "Unauthorized");
    assert.deepEqual(deliveryAdapter.deliveries, []);
  });

  it("rejects active Telegram users without a role binding", async () => {
    const store = createInMemoryIdentityStore({
      users: [
        {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            organizationId: "22222222-2222-4222-8222-222222222222",
            telegramUsername: "norole_user",
            displayName: "No Role User",
            status: "active",
          },
          organization: {
            id: "22222222-2222-4222-8222-222222222222",
            slug: "no-role-org",
            name: "No Role Org",
            status: "active",
          },
          roles: [],
        },
      ],
    });
    const { deliveryAdapter, service } = createTestService({ store });

    const response = await service.startTelegramLogin({
      telegramUsername: "norole_user",
    });

    assert.equal(response.status, 401);
    assert.match(response.body.detail, /role binding/i);
    assert.deepEqual(deliveryAdapter.deliveries, []);
  });

  it("verifies a code once and issues a server session token without storing it raw", async () => {
    const { service, store } = createTestService();
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });

    const verify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });

    assert.equal(verify.status, 200);
    assert.equal(verify.body.authenticated, true);
    assert.equal(verify.body.implementationStage, "M1");
    assert.equal(verify.body.session.mode, "server");
    assert.match(verify.body.token, /^brs_[A-Za-z0-9_-]+$/);
    assert.equal(verify.body.user.telegramUsername, "seeded_admin");
    assert.deepEqual(verify.body.roles, ["administrator"]);

    const consumedCode = await store.findLoginCodeById(start.body.requestId);
    assert.equal(consumedCode.consumedAt, BASE_TIME.toISOString());

    const session = await store.findSessionByTokenHash(
      service.hashSessionToken(verify.body.token),
    );
    assert.equal(session.token, undefined);
    assert.match(session.tokenHash, /^sha256:/);
    assert.equal(session.revokedAt, null);

    const secondVerify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });

    assert.equal(secondVerify.status, 401);
    assert.equal(secondVerify.body.title, "Unauthorized");
  });

  it("rejects expired login codes and expired sessions", async () => {
    const { clock, service } = createTestService();
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });

    clock.advanceSeconds(301);

    const expiredCode = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });

    assert.equal(expiredCode.status, 401);
    assert.match(expiredCode.body.detail, /expired/i);

    const freshStart = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });
    const verify = await service.verifyTelegramLogin({
      requestId: freshStart.body.requestId,
      code: "123456",
    });

    clock.advanceSeconds(8 * 60 * 60 + 1);

    const session = await service.getSessionByToken(verify.body.token);

    assert.equal(session.status, 401);
    assert.match(session.body.detail, /expired/i);
  });

  it("locks a login challenge after repeated wrong code attempts", async () => {
    const { service } = createTestService({
      maxVerifyAttempts: 3,
    });
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await service.verifyTelegramLogin({
        requestId: start.body.requestId,
        code: "000000",
      });
      assert.equal(response.status, 401);
    }

    const locked = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "000000",
    });

    assert.equal(locked.status, 429);
    assert.equal(locked.body.title, "Too Many Requests");

    const correctAfterLock = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });

    assert.equal(correctAfterLock.status, 429);
  });

  it("revokes sessions on logout", async () => {
    const { service } = createTestService();
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });
    const verify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });
    const session = await service.getSessionByToken(verify.body.token);

    assert.equal(session.status, 200);

    const logout = await service.logout(session.body);

    assert.equal(logout.status, 200);
    assert.equal(logout.body.loggedOut, true);

    const afterLogout = await service.getSessionByToken(verify.body.token);

    assert.equal(afterLogout.status, 401);
    assert.match(afterLogout.body.detail, /revoked/i);
  });

  it("records audit events for login start, failed verify, successful login, and logout", async () => {
    const { auditRecorder, service } = createTestService();
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });

    await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "000000",
    });
    const verify = await service.verifyTelegramLogin(
      {
        requestId: start.body.requestId,
        code: "123456",
      },
      {
        ip: "127.0.0.1",
        userAgent: "identity-unit-test",
      },
    );
    const session = await service.getSessionByToken(verify.body.token);
    await service.logout(session.body);

    assert.deepEqual(
      auditRecorder.events.map((event) => ({
        action: event.action,
        objectType: event.objectType,
        result: event.result,
      })),
      [
        {
          action: IDENTITY_AUDIT_ACTIONS.loginStart,
          objectType: "login_code",
          result: "success",
        },
        {
          action: IDENTITY_AUDIT_ACTIONS.loginFailure,
          objectType: "login_code",
          result: "failure",
        },
        {
          action: IDENTITY_AUDIT_ACTIONS.loginSuccess,
          objectType: "auth_session",
          result: "success",
        },
        {
          action: IDENTITY_AUDIT_ACTIONS.sessionLogout,
          objectType: "auth_session",
          result: "success",
        },
      ],
    );
    assert.equal(auditRecorder.events[0].actorUserId, verify.body.user.id);
    assert.equal(auditRecorder.events[0].organizationId, verify.body.organization.id);
    assert.equal(auditRecorder.events[1].metadata.reason, "code_invalid");
    assert.equal(auditRecorder.events[2].metadata.loginCodeId, start.body.requestId);
    assert.equal(auditRecorder.events[2].ip, "127.0.0.1");
    assert.deepEqual(auditRecorder.events[2].metadata.roleCodes, ["administrator"]);
  });
});
