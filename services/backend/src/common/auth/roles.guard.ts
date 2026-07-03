import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { AuthenticatedRequest, RoleCode } from "./auth-context";
import { effectiveRoles } from "./auth-context";
import { ROLES_KEY } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles =
      this.reflector.getAllAndOverride<readonly RoleCode[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.auth;

    if (!auth) {
      throw new UnauthorizedException({
        code: "AUTH_REQUIRED",
        description: "Authentication is required before role authorization.",
        humanMessage: "Необходима активная сессия.",
      });
    }

    const roles = effectiveRoles(auth.roles);

    if (requiredRoles.some((role) => roles.has(role))) {
      return true;
    }

    throw new ForbiddenException({
      code: "ROLE_FORBIDDEN",
      description: `Required role: ${requiredRoles.join(" or ")}`,
      humanMessage: "Недостаточно прав для выполнения операции.",
    });
  }
}
