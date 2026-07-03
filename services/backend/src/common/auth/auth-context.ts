import type { Request } from "express";

export const AUTH_HASH_SECRET_ENV = "AUTH_HASH_SECRET";
export const DEFAULT_AUTH_HASH_SECRET = "bridge-local-dev-auth-secret";

export type RoleCode = "platform_operator" | "administrator" | "manager";

export interface RoleBinding {
  organizationId: string;
  role: RoleCode;
}

export interface AuthSessionContext {
  authenticated: true;
  expiresAt: string;
  implementationStage: "M2";
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  roleBindings: RoleBinding[];
  roles: RoleCode[];
  session: {
    expiresAt: string;
    id: string;
    issuedAt: string;
    mode: "server";
    revokedAt: string | null;
  };
  token: string;
  user: {
    displayName: string;
    id: string;
    organizationId: string;
    role: RoleCode | null;
    status: string;
    telegramUsername: string | null;
  };
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthSessionContext;
}

const ROLE_CODES = new Set<string>(["platform_operator", "administrator", "manager"]);

export function isRoleCode(value: string): value is RoleCode {
  return ROLE_CODES.has(value);
}

export function primaryRole(roles: readonly RoleCode[]): RoleCode | null {
  if (roles.includes("administrator")) {
    return "administrator";
  }

  if (roles.includes("manager")) {
    return "manager";
  }

  if (roles.includes("platform_operator")) {
    return "platform_operator";
  }

  return null;
}

export function effectiveRoles(roles: readonly RoleCode[]): Set<RoleCode> {
  const effective = new Set<RoleCode>(roles);

  if (roles.includes("administrator")) {
    effective.add("manager");
  }

  return effective;
}
