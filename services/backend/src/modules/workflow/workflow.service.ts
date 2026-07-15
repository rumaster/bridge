import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import {
  CreateWorkflowVersionDto,
  ImportWorkflowSchemaDto,
  SaveWorkflowDraftDto,
  UpdateWorkflowDto,
  WorkflowExportRow,
  WorkflowDraftResponseDto,
  WorkflowDraftRow,
  WorkflowImportResponseDto,
  WorkflowInstanceDetailResponseDto,
  WorkflowInstanceLogRow,
  WorkflowInstanceResponseDto,
  WorkflowInstanceRow,
  WorkflowResponseDto,
  WorkflowRow,
  WorkflowSchemaExportResponseDto,
  WORKFLOW_SCHEMA_EXPORT_CONTRACT,
  WORKFLOW_SCHEMA_EXPORT_VERSION,
  WorkflowStatus,
  WorkflowVersionResponseDto,
  WorkflowVersionRow,
  mapWorkflowDraft,
  mapWorkflow,
  mapWorkflowInstance,
  mapWorkflowLog,
  mapWorkflowVersion,
} from "./workflow.dto";
import {
  collectBackendApiOperationIds,
  collectWaitEventNodes,
  collectWorkflowSubSchemaSlugs,
  createWorkflowSchemaValidationException,
  validateWorkflowSchema,
  validateWorkflowSchemaShape,
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
      await this.assertWorkflowSchemaPersistable(client, organizationId, payload.schema);

      const version = await this.insertWorkflowVersion(
        client,
        organizationId,
        workflowId,
        payload.schema,
        actorUserId,
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
          [organizationId, workflowId, version.id],
        );
      }

      return mapWorkflowVersion(version);
    });
  }

  async getDraft(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowDraftResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const workflow = await this.readWorkflowDraft(client, organizationId, workflowId);
      return mapWorkflowDraft(workflow);
    });
  }

  async saveDraft(
    organizationId: string,
    workflowId: string,
    payload: SaveWorkflowDraftDto,
  ): Promise<WorkflowDraftResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      // Драфт проверяется ТОЛЬКО по форме графа (решение A10). Редактор сохраняет
      // его автоматически при выходе и при переходе к другой схеме, поэтому полная
      // валидация здесь означала бы потерю недостроенной работы: у узла ещё не
      // выбрано событие, порт висит — и автосохранение молча отвергается. Полная
      // проверка контракта живёт в promoteDraft, где драфт копируется в рабочую
      // версию.
      const shape = validateWorkflowSchemaShape(payload.schema);
      if (!shape.valid) {
        throw createWorkflowSchemaValidationException(shape.errors);
      }

      const result = await client.query<WorkflowDraftRow>(
        `
          UPDATE workflows
          SET draft_schema = $3::jsonb,
              draft_updated_at = now(),
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, draft_schema, draft_updated_at
        `,
        [organizationId, workflowId, JSON.stringify(payload.schema)],
      );

      if (result.rowCount === 0) {
        throw workflowNotFound(workflowId);
      }

      return mapWorkflowDraft(result.rows[0]);
    });
  }

  async promoteDraft(
    organizationId: string,
    workflowId: string,
    actorUserId: string | undefined,
  ): Promise<WorkflowVersionResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const workflow = await this.readWorkflowDraft(client, organizationId, workflowId);
      if (!workflow.draft_schema) {
        throw workflowDraftMissing(workflowId);
      }

      await this.assertWorkflowSchemaPersistable(client, organizationId, workflow.draft_schema);

      const version = await this.insertWorkflowVersion(
        client,
        organizationId,
        workflowId,
        workflow.draft_schema,
        actorUserId,
      );

      await client.query(
        `
          UPDATE workflows
          SET default_version_id = $3,
              status = 'active',
              draft_schema = NULL,
              draft_updated_at = NULL,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, workflowId, version.id],
      );

      await this.syncEventSubscriptions(client, organizationId, workflowId, version.id, workflow.draft_schema);

      return mapWorkflowVersion(version);
    });
  }

  /**
   * Регистрация и разрегистрация подписок на события (Ревизия 2026-07-15).
   *
   * Узлы «Ожидание события» — точки входа схемы, поэтому подписки существуют
   * только у рабочей версии: у драфта их нет, иначе недостроенная схема
   * запускалась бы на боевых событиях.
   *
   * Синхронизация именно «снести и записать заново», а не доливка: узел могли
   * удалить, переименовать или сменить ему тип события — при доливке осиротевшая
   * подписка продолжила бы запускать схему с несуществующего узла. Всё идёт в той
   * же транзакции, что и сам promote: рассогласование версии и её подписок
   * означало бы запуск чужой схемы.
   */
  private async syncEventSubscriptions(
    client: Queryable,
    organizationId: string,
    workflowId: string,
    versionId: string,
    schema: unknown,
  ): Promise<void> {
    await client.query(
      `DELETE FROM workflow_event_subscriptions WHERE organization_id = $1 AND workflow_id = $2`,
      [organizationId, workflowId],
    );

    for (const node of collectWaitEventNodes(schema)) {
      await client.query(
        `
          INSERT INTO workflow_event_subscriptions
            (id, organization_id, workflow_id, version_id, node_id, event_type, correlation)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          randomUUID(),
          organizationId,
          workflowId,
          versionId,
          node.nodeId,
          node.eventType,
          JSON.stringify(node.correlation),
        ],
      );
    }
  }

  async exportWorkflow(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowSchemaExportResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      const result = await client.query<WorkflowExportRow>(
        `
          SELECT
            w.id AS workflow_id,
            w.name,
            v.id AS version_id,
            v.version_no,
            v.schema
          FROM workflows w
          JOIN workflow_versions v
            ON v.organization_id = w.organization_id
           AND v.workflow_id = w.id
           AND v.id = w.default_version_id
          WHERE w.organization_id = $1 AND w.id = $2
          LIMIT 1
        `,
        [organizationId, workflowId],
      );

      if (result.rowCount === 0) {
        throw workflowDefaultVersionMissing(workflowId);
      }

      const row = result.rows[0];
      return {
        contract: WORKFLOW_SCHEMA_EXPORT_CONTRACT,
        exported_at: new Date().toISOString(),
        schema: row.schema,
        version: WORKFLOW_SCHEMA_EXPORT_VERSION,
        workflow: {
          id: row.workflow_id,
          name: row.name,
          version_id: row.version_id,
          version_no: Number(row.version_no),
        },
      };
    });
  }

  async importWorkflow(
    organizationId: string,
    workflowId: string,
    payload: ImportWorkflowSchemaDto,
    actorUserId: string | undefined,
  ): Promise<WorkflowImportResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      validateWorkflowImportEnvelope(payload);
      await this.assertWorkflowSchemaPersistable(client, organizationId, payload.schema);

      if (payload.target === "version") {
        const version = await this.insertWorkflowVersion(
          client,
          organizationId,
          workflowId,
          payload.schema,
          actorUserId,
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
            [organizationId, workflowId, version.id],
          );
        }

        return {
          target: "version",
          version: mapWorkflowVersion(version),
        };
      }

      const result = await client.query<WorkflowDraftRow>(
        `
          UPDATE workflows
          SET draft_schema = $3::jsonb,
              draft_updated_at = now(),
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, draft_schema, draft_updated_at
        `,
        [organizationId, workflowId, JSON.stringify(payload.schema)],
      );

      if (result.rowCount === 0) {
        throw workflowNotFound(workflowId);
      }

      return {
        draft: mapWorkflowDraft(result.rows[0]),
        target: "draft",
      };
    });
  }

  async resetDraft(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowDraftResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireWorkflow(client, organizationId, workflowId);
      const result = await client.query<WorkflowDraftRow>(
        `
          UPDATE workflows
          SET draft_schema = NULL,
              draft_updated_at = NULL,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, draft_schema, draft_updated_at
        `,
        [organizationId, workflowId],
      );

      if (result.rowCount === 0) {
        throw workflowNotFound(workflowId);
      }

      return mapWorkflowDraft(result.rows[0]);
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

  private async requireActiveSubSchemas(
    client: Queryable,
    organizationId: string,
    schema: Record<string, unknown>,
  ): Promise<void> {
    const missingSubSchemas = await this.subschemas.findMissingActiveSlugs(
      client,
      organizationId,
      collectWorkflowSubSchemaSlugs(schema),
    );
    if (missingSubSchemas.length > 0) {
      throw createWorkflowSchemaValidationException(
        missingSubSchemas.map((slug) => ({
          path: "$.nodes[].config.subSchemaSlug",
          message: `Активная Workflow-субсхема "${slug}" не найдена.`,
        })),
      );
    }
  }

  private async assertWorkflowSchemaPersistable(
    client: Queryable,
    organizationId: string,
    schema: Record<string, unknown>,
  ): Promise<void> {
    const validation = validateWorkflowSchema(schema);
    if (!validation.valid) {
      throw createWorkflowSchemaValidationException(validation.errors);
    }
    await this.requireAllowedBackendApiCalls(client, schema);
    await this.requireActiveSubSchemas(client, organizationId, schema);
  }

  /**
   * Витрина вызовов Backend API (решение A3). Контракт уже проверил, что вызов
   * ЕСТЬ в каталоге, сгенерированном из OpenAPI; здесь — что его РАЗРЕШИЛ
   * platform_operator. Проверка живёт на Backend, а не в контракте, потому что
   * витрина — состояние БД, редактируемое без деплоя.
   *
   * Проверяется при каждом сохранении, а не только при выборе в редакторе: иначе
   * операцию можно было бы закрыть в витрине, а уже сохранённые схемы продолжили
   * бы её дёргать.
   */
  private async requireAllowedBackendApiCalls(client: Queryable, schema: unknown): Promise<void> {
    const operationIds = collectBackendApiOperationIds(schema);
    if (operationIds.length === 0) return;

    const result = await client.query<{ operation_id: string }>(
      `
        SELECT operation_id
        FROM workflow_backend_api_allowlist
        WHERE enabled AND operation_id = ANY($1::text[])
      `,
      [operationIds],
    );

    const allowed = new Set(result.rows.map((row) => row.operation_id));
    const forbidden = operationIds.filter((id) => !allowed.has(id));
    if (forbidden.length > 0) {
      throw createWorkflowSchemaValidationException(
        forbidden.map((id) => ({
          path: "$.nodes",
          message: `Вызов Backend API «${id}» не разрешён в витрине. Откройте его на странице вызовов Backend API.`,
        })),
      );
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

  private async readWorkflowDraft(
    client: Queryable,
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowDraftRow> {
    const result = await client.query<WorkflowDraftRow>(
      `
        SELECT id, organization_id, draft_schema, draft_updated_at
        FROM workflows
        WHERE organization_id = $1 AND id = $2
        LIMIT 1
      `,
      [organizationId, workflowId],
    );

    if (result.rowCount === 0) {
      throw workflowNotFound(workflowId);
    }

    return result.rows[0];
  }

  private async insertWorkflowVersion(
    client: Queryable,
    organizationId: string,
    workflowId: string,
    schema: Record<string, unknown>,
    actorUserId: string | undefined,
  ): Promise<WorkflowVersionRow> {
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
        JSON.stringify(schema),
        actorUserId ?? null,
      ],
    );

    return result.rows[0];
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

function workflowDraftMissing(workflowId: string): BadRequestException {
  return new BadRequestException({
    code: "WORKFLOW_DRAFT_MISSING",
    description: `Workflow ${workflowId} has no draft schema to promote.`,
    humanMessage: "У Workflow нет черновика для публикации.",
  });
}

function workflowDefaultVersionMissing(workflowId: string): BadRequestException {
  return new BadRequestException({
    code: "WORKFLOW_DEFAULT_VERSION_MISSING",
    description: `Workflow ${workflowId} has no active default version to export.`,
    humanMessage: "У Workflow нет активной версии для экспорта.",
  });
}

function workflowImportInvalid(message: string): BadRequestException {
  return new BadRequestException({
    code: "WORKFLOW_IMPORT_INVALID",
    description: message,
    humanMessage: "JSON импорта Workflow некорректен.",
  });
}

function validateWorkflowImportEnvelope(payload: ImportWorkflowSchemaDto): void {
  if (
    payload.contract !== undefined &&
    payload.contract !== WORKFLOW_SCHEMA_EXPORT_CONTRACT
  ) {
    throw workflowImportInvalid(
      `contract должен быть "${WORKFLOW_SCHEMA_EXPORT_CONTRACT}".`,
    );
  }

  if (
    payload.version !== undefined &&
    payload.version !== WORKFLOW_SCHEMA_EXPORT_VERSION
  ) {
    throw workflowImportInvalid(`version должен быть "${WORKFLOW_SCHEMA_EXPORT_VERSION}".`);
  }
}

function workflowInstanceNotFound(instanceId: string): NotFoundException {
  return new NotFoundException({
    code: "WORKFLOW_INSTANCE_NOT_FOUND",
    description: `Workflow instance ${instanceId} was not found.`,
    humanMessage: "Инстанс Workflow не найден.",
  });
}
