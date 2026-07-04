import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

import { PgDatabase } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuditActorType } from "../audit/audit.service";
import {
  DEFAULT_CONFIGURATION_KEY,
  ORGANIZATION_CONFIGURATION_FIELDS,
  emptyConfiguration,
  emptyOrganizationConfiguration,
  mapConfiguration,
  mapOrganizationConfiguration,
  normalizeOrganizationConfigurationValue,
} from "./configuration.dto";
import type {
  ConfigurationResponseDto,
  ConfigurationRow,
  OrganizationConfigurationResponseDto,
  OrganizationConfigurationValue,
  PutConfigurationDto,
  PutOrganizationConfigurationDto,
} from "./configuration.dto";

export interface ConfigurationMutationContext {
  actorType?: AuditActorType;
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

  async getOrganizationConfiguration(
    organizationId: string,
  ): Promise<OrganizationConfigurationResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await this.readConfigurationRow(
        client,
        organizationId,
        DEFAULT_CONFIGURATION_KEY,
      );

      return result
        ? mapOrganizationConfiguration(result)
        : emptyOrganizationConfiguration(organizationId);
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
        actorType: context.actorType,
        actorUserId: context.actorUserId,
        metadata: { key, version: result.rows[0].version },
        objectType: "configuration",
        organizationId,
        requestId: context.requestId,
      });

      return mapConfiguration(result.rows[0]);
    });
  }

  async putOrganizationConfiguration(
    organizationId: string,
    payload: PutOrganizationConfigurationDto,
    context: ConfigurationMutationContext,
  ): Promise<OrganizationConfigurationResponseDto> {
    const value = normalizeOrganizationConfigurationValue({
      aiAssistantEnabled: payload.aiAssistantEnabled,
      defaultLanguage: payload.defaultLanguage,
      monthlyMessageLimit: payload.monthlyMessageLimit,
      notificationEmail: payload.notificationEmail,
      retentionDays: payload.retentionDays,
      workflowAutomationEnabled: payload.workflowAutomationEnabled,
    });

    return this.database.withTenant(organizationId, async (client) =>
      this.writeOrganizationConfiguration(client, organizationId, value, context),
    );
  }

  async patchOrganizationConfiguration(
    organizationId: string,
    payload: Record<string, unknown>,
    context: ConfigurationMutationContext,
  ): Promise<OrganizationConfigurationResponseDto> {
    const patch = this.pickOrganizationConfigurationPatch(payload);

    return this.database.withTenant(organizationId, async (client) => {
      const current = await this.readConfigurationRow(
        client,
        organizationId,
        DEFAULT_CONFIGURATION_KEY,
      );
      const value = {
        ...normalizeOrganizationConfigurationValue(current?.value),
        ...patch,
      };

      return this.writeOrganizationConfiguration(client, organizationId, value, context);
    });
  }

  private async readConfigurationRow(
    client: PoolClient,
    organizationId: string,
    key: string,
  ): Promise<ConfigurationRow | null> {
    const result = await client.query<ConfigurationRow>(
      `
        SELECT organization_id, key, value, version, updated_by, updated_at
        FROM configurations
        WHERE organization_id = $1 AND key = $2
      `,
      [organizationId, key],
    );

    return result.rowCount === 0 ? null : result.rows[0];
  }

  private async writeOrganizationConfiguration(
    client: PoolClient,
    organizationId: string,
    value: OrganizationConfigurationValue,
    context: ConfigurationMutationContext,
  ): Promise<OrganizationConfigurationResponseDto> {
    const result = await this.writeConfigurationValue(
      client,
      organizationId,
      DEFAULT_CONFIGURATION_KEY,
      value,
      context,
    );

    return mapOrganizationConfiguration(result);
  }

  private async writeConfigurationValue(
    client: PoolClient,
    organizationId: string,
    key: string,
    value: object,
    context: ConfigurationMutationContext,
  ): Promise<ConfigurationRow> {
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
        JSON.stringify(value),
        context.actorUserId ?? null,
      ],
    );

    await this.audit.record(client, {
      action: "configuration.put",
      actorType: context.actorType,
      actorUserId: context.actorUserId,
      metadata: { key, version: result.rows[0].version },
      objectType: "configuration",
      organizationId,
      requestId: context.requestId,
    });

    return result.rows[0];
  }

  private pickOrganizationConfigurationPatch(
    payload: Record<string, unknown>,
  ): Partial<OrganizationConfigurationValue> {
    const patch: Partial<OrganizationConfigurationValue> = {};

    for (const field of ORGANIZATION_CONFIGURATION_FIELDS) {
      if (!Object.hasOwn(payload, field)) {
        continue;
      }

      const value = payload[field];
      switch (field) {
        case "aiAssistantEnabled":
        case "workflowAutomationEnabled":
          if (typeof value !== "boolean") {
            throw invalidConfigurationPatch(field, "must be a boolean");
          }
          patch[field] = value;
          break;
        case "monthlyMessageLimit":
          if (!Number.isInteger(value) || Number(value) < 100) {
            throw invalidConfigurationPatch(field, "must be an integer greater than or equal to 100");
          }
          patch[field] = Number(value);
          break;
        case "retentionDays":
          if (!Number.isInteger(value) || Number(value) < 1) {
            throw invalidConfigurationPatch(field, "must be a positive integer");
          }
          patch[field] = Number(value);
          break;
        case "defaultLanguage":
          if (typeof value !== "string" || !/^[a-z]{2}$/.test(value)) {
            throw invalidConfigurationPatch(field, "must be a two-letter language code");
          }
          patch[field] = value;
          break;
        case "notificationEmail":
          if (typeof value !== "string" || value.length > 320) {
            throw invalidConfigurationPatch(field, "must be a string up to 320 characters");
          }
          patch[field] = value;
          break;
      }
    }

    return patch;
  }
}

function invalidConfigurationPatch(field: string, reason: string): BadRequestException {
  return new BadRequestException({
    code: "CONFIGURATION_SCHEMA_INVALID",
    description: `Organization configuration field '${field}' ${reason}.`,
    humanMessage: "Некорректная структура конфигурации организации.",
  });
}
