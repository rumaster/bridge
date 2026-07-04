import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIdentityModule } from "../../src/modules/identity/identity-module.mjs";

describe("identity module skeleton", () => {
  it("registers all C3.auth M1 routes", () => {
    const identityModule = createIdentityModule();
    const routes = identityModule.routes.map(({ method, path }) => ({
      method,
      path,
    }));

    assert.equal(identityModule.name, "identity");
    assert.equal(identityModule.contractId, "C3.auth/C3.platform/C3.users");
    assert.deepEqual(routes, [
      {
        method: "POST",
        path: "/api/v1/auth/login/telegram/start",
      },
      {
        method: "POST",
        path: "/api/v1/auth/login/telegram/verify",
      },
      {
        method: "POST",
        path: "/api/v1/auth/logout",
      },
      {
        method: "GET",
        path: "/api/v1/auth/session",
      },
      {
        method: "POST",
        path: "/api/v1/platform/organizations",
      },
      {
        method: "POST",
        path: "/api/v1/platform/organizations/:id/administrators",
      },
      {
        method: "POST",
        path: "/api/v1/platform/organizations/:id/block",
      },
      {
        method: "POST",
        path: "/api/v1/invitations",
      },
      {
        method: "POST",
        path: "/api/v1/invitations/accept",
      },
    ]);
  });
});
