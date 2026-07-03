import type { Request } from "express";

import { requestedOrganizationId } from "../../src/common/auth/session-auth.guard";

function requestOf(request: Partial<Request>): Request {
  return request as Request;
}

describe("SessionAuthGuard requestedOrganizationId", () => {
  it("extracts tenant scope from organization resource routes without changing the OpenAPI path parameter name", () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";

    expect(
      requestedOrganizationId(
        requestOf({
          headers: {},
          originalUrl: `/api/v1/organizations/${organizationId}?include=settings`,
          params: {
            id: organizationId,
          },
        }),
      ),
    ).toBe(organizationId);
  });

  it("does not treat generic resource ids as tenant scope", () => {
    expect(
      requestedOrganizationId(
        requestOf({
          headers: {},
          originalUrl: "/api/v1/clients/22222222-2222-4222-8222-222222222222",
          params: {
            id: "11111111-1111-4111-8111-111111111111",
          },
        }),
      ),
    ).toBeNull();
  });
});
