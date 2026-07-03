import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import { mapUser } from "./user.dto";
import type {
  CreateUserDto,
  PatchUserDto,
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
      await this.replaceRoles(client, organizationId, userId, payload.roleCodes ?? ["manager"]);

      await this.audit.record(client, {
        action: "user.create",
        actorUserId: context.actorUserId,
        metadata: { roleCodes: payload.roleCodes ?? ["manager"] },
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

      if (payload.roleCodes) {
        await this.replaceRoles(client, organizationId, userId, payload.roleCodes);
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

      return this.getUserInTransaction(client, organizationId, userId);
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
  ): Promise<void> {
    const normalizedRoleCodes = [...new Set(roleCodes.map((roleCode) => roleCode.trim()))];
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
