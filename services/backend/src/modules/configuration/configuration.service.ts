import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import {
  DEFAULT_CONFIGURATION_KEY,
  emptyConfiguration,
  mapConfiguration,
} from "./configuration.dto";
import type {
  ConfigurationResponseDto,
  ConfigurationRow,
  PutConfigurationDto,
} from "./configuration.dto";

export interface ConfigurationMutationContext {
  actorUserId?: string;
  requestId?: string;
}

@Injectable()
export class ConfigurationService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
  ) {}

  async getConfiguration(
    organizationId: string,
    key = DEFAULT_CONFIGURATION_KEY,
  ): Promise<ConfigurationResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ConfigurationRow>(
        `
          SELECT organization_id, key, value, version, updated_by, updated_at
          FROM configurations
          WHERE organization_id = $1 AND key = $2
        `,
        [organizationId, key],
      );

      return result.rowCount === 0
        ? emptyConfiguration(organizationId, key)
        : mapConfiguration(result.rows[0]);
    });
  }

  async putConfiguration(
    organizationId: string,
    payload: PutConfigurationDto,
    context: ConfigurationMutationContext,
  ): Promise<ConfigurationResponseDto> {
    const key = payload.key ?? DEFAULT_CONFIGURATION_KEY;

    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ConfigurationRow>(
        `
          INSERT INTO configurations (
            id,
            organization_id,
            key,
            value,
            version,
            updated_by,
            updated_at
          )
          VALUES ($1, $2, $3, $4::jsonb, 1, $5, now())
          ON CONFLICT (organization_id, key) DO UPDATE SET
            value = EXCLUDED.value,
            version = configurations.version + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
          RETURNING organization_id, key, value, version, updated_by, updated_at
        `,
        [
          randomUUID(),
          organizationId,
          key,
          JSON.stringify(payload.value),
          context.actorUserId ?? null,
        ],
      );

      await this.audit.record(client, {
        action: "configuration.put",
        actorUserId: context.actorUserId,
        metadata: { key, version: result.rows[0].version },
        objectType: "configuration",
        organizationId,
        requestId: context.requestId,
      });

      return mapConfiguration(result.rows[0]);
    });
  }
}
