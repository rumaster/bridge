import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import {
  CreateWorkflowVersionDto,
  UpdateWorkflowDto,
  WorkflowInstanceDetailResponseDto,
  WorkflowInstanceLogRow,
  WorkflowInstanceResponseDto,
  WorkflowInstanceRow,
  WorkflowResponseDto,
  WorkflowRow,
  WorkflowStatus,
  WorkflowVersionResponseDto,
  WorkflowVersionRow,
  mapWorkflow,
  mapWorkflowInstance,
  mapWorkflowLog,
  mapWorkflowVersion,
} from "./workflow.dto";
import {
  collectWorkflowSubSchemaSlugs,
  createWorkflowSchemaValidationException,
  validateWorkflowSchema,
} from "./workflow-schema.validator";
import { WorkflowSubschemaService } from "./workflow-subschema.service";

@Injectable()
export class WorkflowService {
  constructor(
    private readonly database: PgDatabase,
    private readonly subschemas: WorkflowSubschemaService,
  ) {}

  async listWorkflows(organizationId: string): Promise<WorkflowResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<WorkflowRow>(
        `
          SELECT id, organization_id, name, status, default_version_id, created_at, updated_at
          FROM workflows
          WHERE organization_id = $1
          ORDER BY updated_at DESC, id
        `,
        [organizationId],
      );

      return result.rows.map(mapWorkflow);
    });
  }

  async listVersions(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowVersionResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      const result = await client.query<WorkflowVersionRow>(
        `
          SELECT id, organization_id, workflow_id, version_no, schema, created_by, created_at
          FROM workflow_versions
          WHERE organization_id = $1 AND workflow_id = $2
          ORDER BY version_no ASC
        `,
        [organizationId, workflowId],
      );

      return result.rows.map(mapWorkflowVersion);
    });
  }

  async createVersion(
    organizationId: string,
    workflowId: string,
    payload: CreateWorkflowVersionDto,
    actorUserId: string | undefined,
  ): Promise<WorkflowVersionResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      const validation = validateWorkflowSchema(payload.schema);
      if (!validation.valid) {
        throw createWorkflowSchemaValidationException(validation.errors);
      }
      const missingSubSchemas = await this.subschemas.findMissingActiveSlugs(
        client,
        organizationId,
        collectWorkflowSubSchemaSlugs(payload.schema),
      );
      if (missingSubSchemas.length > 0) {
        throw createWorkflowSchemaValidationException(
          missingSubSchemas.map((slug) => ({
            path: "$.nodes[].config.subSchemaSlug",
            message: `Активная Workflow-субсхема "${slug}" не найдена.`,
          })),
        );
      }

      const versionNoResult = await client.query<{ version_no: number | string }>(
        `
          SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
          FROM workflow_versions
          WHERE organization_id = $1 AND workflow_id = $2
        `,
        [organizationId, workflowId],
      );
      const versionId = randomUUID();
      const versionNo = Number(versionNoResult.rows[0]?.version_no ?? 1);
      const result = await client.query<WorkflowVersionRow>(
        `
          INSERT INTO workflow_versions (
            id,
            organization_id,
            workflow_id,
            version_no,
            schema,
            created_by,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
          RETURNING id, organization_id, workflow_id, version_no, schema, created_by, created_at
        `,
        [
          versionId,
          organizationId,
          workflowId,
          versionNo,
          JSON.stringify(payload.schema),
          actorUserId ?? null,
        ],
      );

      if (payload.activate) {
        await client.query(
          `
            UPDATE workflows
            SET default_version_id = $3,
                status = 'active',
                updated_at = now()
            WHERE organization_id = $1 AND id = $2
          `,
          [organizationId, workflowId, versionId],
        );
      }

      return mapWorkflowVersion(result.rows[0]);
    });
  }

  async updateWorkflow(
    organizationId: string,
    workflowId: string,
    payload: UpdateWorkflowDto,
  ): Promise<WorkflowResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const nextStatus = resolveNextStatus(payload);
      const hasDefaultVersion = payload.default_version_id !== undefined;

      if (hasDefaultVersion) {
        await this.requireWorkflowVersion(
          client,
          organizationId,
          workflowId,
          payload.default_version_id as string,
        );
      }

      const result = await client.query<WorkflowRow>(
        `
          UPDATE workflows
          SET status = CASE WHEN $3 THEN $4::text ELSE status END,
              default_version_id = CASE WHEN $5 THEN $6::uuid ELSE default_version_id END,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, name, status, default_version_id, created_at, updated_at
        `,
        [
          organizationId,
          workflowId,
          nextStatus !== undefined,
          nextStatus ?? null,
          hasDefaultVersion,
          payload.default_version_id ?? null,
        ],
      );

      if (result.rowCount === 0) {
        throw workflowNotFound(workflowId);
      }

      return mapWorkflow(result.rows[0]);
    });
  }

  async listInstances(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowInstanceResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      const result = await client.query<WorkflowInstanceRow>(
        `
          SELECT
            i.id,
            i.organization_id,
            i.workflow_id,
            i.version_id,
            v.version_no,
            i.status,
            i.started_at,
            i.finished_at,
            i.created_at
          FROM workflow_instances i
          JOIN workflow_versions v
            ON v.organization_id = i.organization_id AND v.id = i.version_id
          WHERE i.organization_id = $1 AND i.workflow_id = $2
          ORDER BY i.created_at DESC, i.id
        `,
        [organizationId, workflowId],
      );

      return result.rows.map(mapWorkflowInstance);
    });
  }

  async getInstance(
    organizationId: string,
    workflowId: string,
    instanceId: string,
  ): Promise<WorkflowInstanceDetailResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const instanceResult = await client.query<WorkflowInstanceRow>(
        `
          SELECT
            i.id,
            i.organization_id,
            i.workflow_id,
            i.version_id,
            v.version_no,
            i.status,
            i.started_at,
            i.finished_at,
            i.created_at
          FROM workflow_instances i
          JOIN workflow_versions v
            ON v.organization_id = i.organization_id AND v.id = i.version_id
          WHERE i.organization_id = $1 AND i.workflow_id = $2 AND i.id = $3
          LIMIT 1
        `,
        [organizationId, workflowId, instanceId],
      );

      if (instanceResult.rowCount === 0) {
        throw workflowInstanceNotFound(instanceId);
      }

      const logsResult = await client.query<WorkflowInstanceLogRow>(
        `
          SELECT id, node_id, event, data, created_at
          FROM workflow_execution_logs
          WHERE organization_id = $1 AND instance_id = $2
          ORDER BY created_at ASC, id
        `,
        [organizationId, instanceId],
      );

      return {
        ...mapWorkflowInstance(instanceResult.rows[0]),
        logs: logsResult.rows.map(mapWorkflowLog),
      };
    });
  }

  private async requireWorkflow(
    client: Queryable,
    organizationId: string,
    workflowId: string,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM workflows
        WHERE organization_id = $1 AND id = $2
        LIMIT 1
      `,
      [organizationId, workflowId],
    );

    if (result.rowCount === 0) {
      throw workflowNotFound(workflowId);
    }
  }

  private async requireWorkflowVersion(
    client: Queryable,
    organizationId: string,
    workflowId: string,
    versionId: string,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM workflow_versions
        WHERE organization_id = $1 AND workflow_id = $2 AND id = $3
        LIMIT 1
      `,
      [organizationId, workflowId, versionId],
    );

    if (result.rowCount === 0) {
      throw workflowVersionNotFound(versionId);
    }
  }
}

function resolveNextStatus(payload: UpdateWorkflowDto): undefined | WorkflowStatus {
  if (payload.status) {
    return payload.status;
  }

  if (payload.enabled === undefined) {
    return undefined;
  }

  return payload.enabled ? "active" : "archived";
}

function workflowNotFound(workflowId: string): NotFoundException {
  return new NotFoundException({
    code: "WORKFLOW_NOT_FOUND",
    description: `Workflow ${workflowId} was not found.`,
    humanMessage: "Workflow не найден.",
  });
}

function workflowVersionNotFound(versionId: string): NotFoundException {
  return new NotFoundException({
    code: "WORKFLOW_VERSION_NOT_FOUND",
    description: `Workflow version ${versionId} was not found.`,
    humanMessage: "Версия Workflow не найдена.",
  });
}

function workflowInstanceNotFound(instanceId: string): NotFoundException {
  return new NotFoundException({
    code: "WORKFLOW_INSTANCE_NOT_FOUND",
    description: `Workflow instance ${instanceId} was not found.`,
    humanMessage: "Инстанс Workflow не найден.",
  });
}
