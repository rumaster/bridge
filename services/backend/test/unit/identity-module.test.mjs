import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIdentityModule } from "../../src/modules/identity/identity-module.mjs";

describe("identity module skeleton", () => {
  it("registers all C3.auth M0 routes", () => {
    const identityModule = createIdentityModule();
    const routes = identityModule.routes.map(({ method, path }) => ({
      method,
      path,
    }));

    assert.equal(identityModule.name, "identity");
    assert.equal(identityModule.contractId, "C3.auth");
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
    ]);
  });
});
