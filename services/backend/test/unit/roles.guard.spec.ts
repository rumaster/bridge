import "reflect-metadata";

import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthSessionContext } from "../../src/common/auth/auth-context";
import { RolesGuard } from "../../src/common/auth/roles.guard";
import { ROLES_KEY } from "../../src/common/auth/roles.decorator";

class DemoController {}

function contextFor(
  requiredRoles: string[],
  auth?: Pick<AuthSessionContext, "roles">,
): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, requiredRoles, handler);

  return {
    getClass: () => DemoController,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        auth,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  const guard = new RolesGuard(new Reflector());

  it("allows Manager customer-work actions", () => {
    expect(guard.canActivate(contextFor(["manager"], { roles: ["manager"] }))).toBe(true);
  });

  it("allows Administrator to inherit Manager customer-work actions", () => {
    expect(guard.canActivate(contextFor(["manager"], { roles: ["administrator"] }))).toBe(true);
  });

  it("allows any matching role from a combined role set", () => {
    expect(
      guard.canActivate(contextFor(["administrator"], { roles: ["manager", "administrator"] })),
    ).toBe(true);
  });

  it("rejects Manager for administrative actions", () => {
    expect(() => guard.canActivate(contextFor(["administrator"], { roles: ["manager"] }))).toThrow(
      ForbiddenException,
    );
  });

  it("does not grant tenant actions to Platform Operator without a tenant role", () => {
    expect(() =>
      guard.canActivate(contextFor(["administrator"], { roles: ["platform_operator"] })),
    ).toThrow(ForbiddenException);
  });

  it("requires SessionAuthGuard to attach an auth context first", () => {
    expect(() => guard.canActivate(contextFor(["manager"]))).toThrow(UnauthorizedException);
  });
});
