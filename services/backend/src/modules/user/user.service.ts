import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthSessionContext } from "../../common/auth/auth-context";
import { mapUser, mapUserSession } from "./user.dto";
import type {
  CreateUserDto,
  LogoutSessionResponseDto,
  PatchUserDto,
  RevokeUserSessionsResponseDto,
  UserSessionListResponseDto,
  UserSessionRow,
  UserListResponseDto,
  UserResponseDto,
  UserRow,
} from "./user.dto";

export interface UserMutationContext {
  actorUserId?: string;
  requestId?: string;
}

@Injectable()
export class UserService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
  ) {}

  async listUsers(organizationId: string): Promise<UserListResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<UserRow>(userSelectSql("u.organization_id = $1"), [
        organizationId,
      ]);

      return { items: result.rows.map(mapUser) };
    });
  }

  async listActiveUserSessions(
    organizationId: string,
    userId: string,
    currentSessionId?: string,
  ): Promise<UserSessionListResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.getUserInTransaction(client, organizationId, userId);

      const result = await client.query<UserSessionRow>(
        `
          SELECT
            id,
            user_id,
            organization_id,
            issued_at,
            expires_at,
            revoked_at,
            host(ip) AS ip,
            user_agent
          FROM auth_sessions
          WHERE organization_id = $1
            AND user_id = $2
            AND revoked_at IS NULL
            AND expires_at > now()
          ORDER BY issued_at DESC, id
        `,
        [organizationId, userId],
      );

      return {
        items: result.rows.map((row) => mapUserSession(row, currentSessionId)),
        organizationId,
        userId,
      };
    });
  }

  async createUser(
    organizationId: string,
    payload: CreateUserDto,
    context: UserMutationContext,
  ): Promise<UserResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const userId = randomUUID();
      await client.query(
        `
          INSERT INTO users (
            id,
            organization_id,
            telegram_username,
            email,
            display_name,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          userId,
          organizationId,
          payload.telegramUsername ?? null,
          payload.email ?? null,
          payload.displayName,
          payload.status ?? "active",
        ],
      );
      const roleCodes = await this.replaceRoles(
        client,
        organizationId,
        userId,
        payload.roleCodes ?? ["manager"],
      );

      await this.audit.record(client, {
        action: "user.create",
        actorUserId: context.actorUserId,
        metadata: { roleCodes },
        objectId: userId,
        objectType: "user",
        organizationId,
        requestId: context.requestId,
      });

      return this.getUserInTransaction(client, organizationId, userId);
    });
  }

  async patchUser(
    organizationId: string,
    userId: string,
    payload: PatchUserDto,
    context: UserMutationContext,
  ): Promise<UserResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const before = await this.getUserInTransaction(client, organizationId, userId);
      const result = await client.query(
        `
          UPDATE users
          SET
            telegram_username = CASE WHEN $3 THEN $4 ELSE telegram_username END,
            email = CASE WHEN $5 THEN $6 ELSE email END,
            display_name = COALESCE($7, display_name),
            status = COALESCE($8, status),
            updated_at = now()
          WHERE organization_id = $1 AND id = $2
        `,
        [
          organizationId,
          userId,
          Object.hasOwn(payload, "telegramUsername"),
          payload.telegramUsername ?? null,
          Object.hasOwn(payload, "email"),
          payload.email ?? null,
          payload.displayName ?? null,
          payload.status ?? null,
        ],
      );

      if (result.rowCount === 0) {
        throw notFound("user", userId);
      }

      let nextRoleCodes = before.roleCodes;
      if (payload.roleCodes) {
        nextRoleCodes = await this.replaceRoles(client, organizationId, userId, payload.roleCodes);
      }

      await this.audit.record(client, {
        action: "user.patch",
        actorUserId: context.actorUserId,
        metadata: { roleCodesChanged: Boolean(payload.roleCodes) },
        objectId: userId,
        objectType: "user",
        organizationId,
        requestId: context.requestId,
      });

      if (payload.roleCodes) {
        await this.audit.record(client, {
          action: "access.roles.change",
          actorUserId: context.actorUserId,
          metadata: {
            previousRoleCodes: before.roleCodes,
            roleCodes: nextRoleCodes,
          },
          objectId: userId,
          objectType: "user",
          organizationId,
          requestId: context.requestId,
        });
      }

      if (payload.status && payload.status !== before.status) {
        await this.audit.record(client, {
          action: "access.permissions.change",
          actorUserId: context.actorUserId,
          metadata: {
            previousStatus: before.status,
            status: payload.status,
          },
          objectId: userId,
          objectType: "user",
          organizationId,
          requestId: context.requestId,
        });
      }

      return this.getUserInTransaction(client, organizationId, userId);
    });
  }

  async revokeUserSessions(
    organizationId: string,
    userId: string,
    context: UserMutationContext,
  ): Promise<RevokeUserSessionsResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.getUserInTransaction(client, organizationId, userId);

      const result = await client.query<{ id: string }>(
        `
          UPDATE auth_sessions
          SET revoked_at = now()
          WHERE organization_id = $1
            AND user_id = $2
            AND revoked_at IS NULL
            AND expires_at > now()
          RETURNING id
        `,
        [organizationId, userId],
      );
      const revokedSessionIds = result.rows.map((row) => row.id);

      await this.audit.record(client, {
        action: "auth.session.revoke",
        actorUserId: context.actorUserId,
        metadata: {
          revokedCount: revokedSessionIds.length,
          revokedSessionIds,
        },
        objectId: userId,
        objectType: "user",
        organizationId,
        requestId: context.requestId,
      });

      return {
        organizationId,
        revokedCount: revokedSessionIds.length,
        userId,
      };
    });
  }

  async revokeOwnSession(
    auth: AuthSessionContext,
    context: UserMutationContext,
  ): Promise<LogoutSessionResponseDto> {
    return this.database.withTenant(auth.organization.id, async (client) => {
      const result = await client.query<{ id: string; revoked_at: Date }>(
        `
          UPDATE auth_sessions
          SET revoked_at = now()
          WHERE organization_id = $1
            AND user_id = $2
            AND id = $3
            AND revoked_at IS NULL
            AND expires_at > now()
          RETURNING id, revoked_at
        `,
        [auth.organization.id, auth.user.id, auth.session.id],
      );

      if (result.rowCount === 0) {
        throw notFound("session", auth.session.id);
      }

      await this.audit.record(client, {
        action: "auth.session.logout",
        actorUserId: auth.user.id,
        metadata: {
          sessionRevokedAt: result.rows[0].revoked_at.toISOString(),
        },
        objectId: auth.session.id,
        objectType: "auth_session",
        organizationId: auth.organization.id,
        requestId: context.requestId,
      });

      return {
        implementationStage: "M1",
        loggedOut: true,
        sessionMode: "server",
      };
    });
  }

  private async getUserInTransaction(
    queryable: Queryable,
    organizationId: string,
    userId: string,
  ): Promise<UserResponseDto> {
    const result = await queryable.query<UserRow>(userSelectSql("u.organization_id = $1 AND u.id = $2"), [
      organizationId,
      userId,
    ]);

    if (result.rowCount === 0) {
      throw notFound("user", userId);
    }

    return mapUser(result.rows[0]);
  }

  private async replaceRoles(
    queryable: Queryable,
    organizationId: string,
    userId: string,
    roleCodes: string[],
  ): Promise<string[]> {
    const normalizedRoleCodes = [...new Set(roleCodes.map((roleCode) => roleCode.trim()))].sort();
    if (normalizedRoleCodes.length === 0 || normalizedRoleCodes.some((roleCode) => !roleCode)) {
      throw validationError("roleCodes must contain non-blank role codes");
    }

    const roles = await queryable.query<{ code: string; id: string }>(
      "SELECT id, code FROM roles WHERE code = ANY($1) AND scope = 'organization'",
      [normalizedRoleCodes],
    );
    if (roles.rowCount !== normalizedRoleCodes.length) {
      throw validationError("roleCodes contains unknown organization role");
    }

    await queryable.query(
      "DELETE FROM user_roles WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    for (const role of roles.rows) {
      await queryable.query(
        "INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1, $2, $3)",
        [userId, role.id, organizationId],
      );
    }

    return normalizedRoleCodes;
  }
}

function userSelectSql(whereClause: string): string {
  return `
    SELECT
      u.id,
      u.organization_id,
      u.telegram_username,
      u.email,
      u.display_name,
      u.status,
      u.created_at,
      u.updated_at,
      COALESCE(
        array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
        ARRAY[]::text[]
      ) AS role_codes
    FROM users u
    LEFT JOIN user_roles ur
      ON ur.user_id = u.id AND ur.organization_id = u.organization_id
    LEFT JOIN roles r ON r.id = ur.role_id
    WHERE ${whereClause}
    GROUP BY u.id
    ORDER BY u.display_name, u.id
  `;
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED",
    description: message,
    humanMessage: "Некорректные параметры запроса.",
  });
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}
