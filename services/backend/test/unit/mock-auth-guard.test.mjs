import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEEDED_AUTH_CONTEXT,
  createMockAuthGuard,
} from "../../src/common/auth/mock-auth-guard.mjs";

describe("mock AuthGuard", () => {
  it("allows the request and attaches seeded auth context", () => {
    const request = { headers: {} };
    const guard = createMockAuthGuard();

    assert.equal(guard.canActivate(request), true);
    assert.deepEqual(request.auth, SEEDED_AUTH_CONTEXT);
  });

  it("uses SVC-DATA M0 seeded organization, user and administrator role", () => {
    assert.equal(SEEDED_AUTH_CONTEXT.organization.slug, "demo-organization");
    assert.equal(SEEDED_AUTH_CONTEXT.user.telegramUsername, "seeded_admin");
    assert.deepEqual(SEEDED_AUTH_CONTEXT.roles, ["administrator"]);
  });
});
