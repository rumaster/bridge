import { createHmac } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { PgDatabase } from "../database/database.service";
import {
  AUTH_HASH_SECRET_ENV,
  AuthSessionContext,
  DEFAULT_AUTH_HASH_SECRET,
  RoleBinding,
  RoleCode,
  isRoleCode,
  primaryRole,
} from "./auth-context";

const ORGANIZATION_ID_HEADER = "x-organization-id";
const LOOKUP_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionJoinRow {
  display_name: string;
  expires_at: Date | string;
  id: string;
  issued_at: Date | string;
  organization_id: string;
  organization_name: string;
  organization_status: string;
  revoked_at: Date | string | null;
  role_bindings: unknown;
  roles: string[];
  telegram_username: string | null;
  user_id: string;
  user_status: string;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly database: PgDatabase) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = await this.authenticateRequest(request);

    (request as Request & { auth: AuthSessionContext }).auth = auth;

    return true;
  }

  private async authenticateRequest(request: Request): Promise<AuthSessionContext> {
    const token = extractSessionToken(request);

    if (!token) {
      throw new UnauthorizedException({
        code: "AUTH_REQUIRED",
        description: "Authentication is required.",
        humanMessage: "Необходима активная сессия.",
      });
    }

    const requestedTenant = requestedOrganizationId(request);
    const session = await this.findSessionByToken(token, requestedTenant);

    if (!session) {
      throw new UnauthorizedException({
        code: "SESSION_INVALID",
        description: "Session token is invalid.",
        humanMessage: "Сессия недействительна.",
      });
    }

    if (session.revoked_at) {
      throw new UnauthorizedException({
        code: "SESSION_REVOKED",
        description: "Session has been revoked.",
        humanMessage: "Сессия завершена.",
      });
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: "SESSION_EXPIRED",
        description: "Session has expired.",
        humanMessage: "Срок действия сессии истёк.",
      });
    }

    if (session.user_status !== "active") {
      throw new UnauthorizedException({
        code: "USER_INACTIVE",
        description: "User is not active.",
        humanMessage: "Пользователь не активен.",
      });
    }

    if (session.organization_status !== "active") {
      throw new UnauthorizedException({
        code: "ORGANIZATION_INACTIVE",
        description: "Organization is not active.",
        humanMessage: "Организация не активна.",
      });
    }

    const roles = normalizeRoles(session.roles);

    if (roles.length === 0) {
      throw new UnauthorizedException({
        code: "ROLE_BINDING_REQUIRED",
        description: "Session has no active role binding.",
        humanMessage: "У пользователя нет активной роли.",
      });
    }

    if (
      requestedTenant &&
      requestedTenant !== session.organization_id &&
      !roles.includes("platform_operator")
    ) {
      throw new ForbiddenException({
        code: "TENANT_FORBIDDEN",
        description: "Session does not belong to the requested organization.",
        humanMessage: "Сессия не относится к указанной организации.",
      });
    }

    return toAuthContext(session, roles, token);
  }

  private async findSessionByToken(
    token: string,
    requestedTenant: string | null,
  ): Promise<SessionJoinRow | null> {
    const tokenHash = hashSessionToken(token, authHashSecret());
    const lookupTenant =
      requestedTenant && UUID_PATTERN.test(requestedTenant)
        ? requestedTenant
        : LOOKUP_ORGANIZATION_ID;

    const result = await this.database.withTenant(
      lookupTenant,
      (client) =>
        client.query<SessionJoinRow>(
          `
            SELECT
              s.id,
              s.user_id,
              s.organization_id,
              s.issued_at,
              s.expires_at,
              s.revoked_at,
              u.telegram_username,
              u.display_name,
              u.status AS user_status,
              o.name AS organization_name,
              o.status AS organization_status,
              COALESCE(
                array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
                '{}'::text[]
              ) AS roles,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'role',
                    r.code,
                    'organizationId',
                    ur.organization_id::text
                  )
                  ORDER BY r.code
                ) FILTER (WHERE r.code IS NOT NULL),
                '[]'::jsonb
              ) AS role_bindings
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id AND u.organization_id = s.organization_id
            JOIN organizations o ON o.id = s.organization_id
            LEFT JOIN user_roles ur
              ON ur.user_id = u.id AND ur.organization_id = s.organization_id
            LEFT JOIN roles r ON r.id = ur.role_id
            WHERE s.token_hash = $1
            GROUP BY s.id, u.id, o.id
            LIMIT 1
          `,
          [tokenHash],
        ),
      { isPlatformOperator: true },
    );

    return result.rowCount === 0 ? null : result.rows[0];
  }
}

export function extractSessionToken(request: Request): string | null {
  const authorization = headerValue(request, "authorization");

  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (match) {
      return match[1].trim();
    }
  }

  const cookie = headerValue(request, "cookie");

  if (typeof cookie === "string") {
    const sessionCookie = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("bridge_session="));

    if (sessionCookie) {
      return decodeURIComponent(sessionCookie.slice("bridge_session=".length));
    }
  }

  return null;
}

export function requestedOrganizationId(request: Request): string | null {
  return (
    stringValue(request.params?.organizationId) ??
    stringValue(request.params?.organization_id) ??
    queryValue(request, "organizationId") ??
    queryValue(request, "organization_id") ??
    bodyValue(request, "organizationId") ??
    bodyValue(request, "organization_id") ??
    headerValue(request, ORGANIZATION_ID_HEADER) ??
    null
  );
}

export function hashSessionToken(token: string, secret = authHashSecret()): string {
  return `sha256:${createHmac("sha256", secret)
    .update(`auth_session:server:${token}`)
    .digest("hex")}`;
}

function authHashSecret(): string {
  return process.env[AUTH_HASH_SECRET_ENV] ?? DEFAULT_AUTH_HASH_SECRET;
}

function toAuthContext(
  session: SessionJoinRow,
  roles: RoleCode[],
  token: string,
): AuthSessionContext {
  return {
    authenticated: true,
    expiresAt: normalizeIso(session.expires_at),
    implementationStage: "M2",
    organization: {
      id: session.organization_id,
      name: session.organization_name,
      slug: slugify(session.organization_name),
      status: session.organization_status,
    },
    roleBindings: normalizeRoleBindings(session.role_bindings),
    roles,
    session: {
      expiresAt: normalizeIso(session.expires_at),
      id: session.id,
      issuedAt: normalizeIso(session.issued_at),
      mode: "server",
      revokedAt: normalizeIsoOrNull(session.revoked_at),
    },
    token,
    user: {
      displayName: session.display_name,
      id: session.user_id,
      organizationId: session.organization_id,
      role: primaryRole(roles),
      status: session.user_status,
      telegramUsername: session.telegram_username,
    },
  };
}

function normalizeRoles(roles: readonly string[] | null | undefined): RoleCode[] {
  return [...new Set(roles?.filter(isRoleCode) ?? [])];
}

function normalizeRoleBindings(value: unknown): RoleBinding[] {
  const rawBindings = typeof value === "string" ? safeJsonParse(value) : value;

  if (!Array.isArray(rawBindings)) {
    return [];
  }

  return rawBindings.flatMap((binding) => {
    if (typeof binding !== "object" || binding === null) {
      return [];
    }

    const record = binding as Record<string, unknown>;
    const role = stringValue(record.role);
    const organizationId = stringValue(record.organizationId);

    return role && isRoleCode(role) && organizationId ? [{ role, organizationId }] : [];
  });
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  const value = request.headers[normalizedName];

  return stringValue(value);
}

function queryValue(request: Request, name: string): string | undefined {
  const value = request.query?.[name];

  return stringValue(value);
}

function bodyValue(request: Request, name: string): string | undefined {
  const body = request.body;

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  return stringValue((body as Record<string, unknown>)[name]);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }

  return undefined;
}

function normalizeIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeIsoOrNull(value: Date | string | null): string | null {
  return value ? normalizeIso(value) : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
