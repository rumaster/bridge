import { SetMetadata } from "@nestjs/common";

import type { RoleCode } from "./auth-context";

export const ROLES_KEY = "bridge:roles";

export const Roles = (...roles: RoleCode[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, roles);
