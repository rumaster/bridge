import { NotFoundException, Injectable } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import { mapOrganization } from "./organization.dto";
import type { OrganizationRow } from "./organization.dto";
import type { OrganizationResponseDto, UpdateOrganizationDto } from "./organization.dto";

export interface MutationContext {
  actorUserId?: string;
  requestId?: string;
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
  ) {}

  async getOrganization(id: string): Promise<OrganizationResponseDto> {
    return this.database.withTenant(id, async (client) => {
      const result = await client.query<OrganizationRow>(
        `
          SELECT id, name, description, timezone, locale, status, created_at, updated_at
          FROM organizations
          WHERE id = $1
        `,
        [id],
      );

      if (result.rowCount === 0) {
        throw notFound("organization", id);
      }

      return mapOrganization(result.rows[0]);
    });
  }

  async updateOrganization(
    id: string,
    payload: UpdateOrganizationDto,
    context: MutationContext,
  ): Promise<OrganizationResponseDto> {
    return this.database.withTenant(id, async (client) => {
      const result = await client.query<OrganizationRow>(
        `
          UPDATE organizations
          SET
            name = COALESCE($2, name),
            description = CASE WHEN $3 THEN $4 ELSE description END,
            timezone = COALESCE($5, timezone),
            locale = COALESCE($6, locale),
            status = COALESCE($7, status),
            updated_at = now()
          WHERE id = $1
          RETURNING id, name, description, timezone, locale, status, created_at, updated_at
        `,
        [
          id,
          payload.name ?? null,
          Object.hasOwn(payload, "description"),
          payload.description ?? null,
          payload.timezone ?? null,
          payload.locale ?? null,
          payload.status ?? null,
        ],
      );

      if (result.rowCount === 0) {
        throw notFound("organization", id);
      }

      await this.audit.record(client, {
        action: "organization.update",
        actorUserId: context.actorUserId,
        objectId: id,
        objectType: "organization",
        organizationId: id,
        requestId: context.requestId,
      });

      return mapOrganization(result.rows[0]);
    });
  }
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}
