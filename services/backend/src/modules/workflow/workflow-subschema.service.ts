import { randomUUID } from "node:crypto";

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import {
  createWorkflowSchemaValidationException,
  validateWorkflowSchema,
} from "./workflow-schema.validator";
import {
  CreateWorkflowSubschemaDto,
  UpdateWorkflowSubschemaDto,
  WorkflowSubschemaResponseDto,
  WorkflowSubschemaRow,
  mapWorkflowSubschema,
} from "./workflow.dto";

/**
 * Пустая заготовка субсхемы: обязательные границы `start`/`end` — ровно по одной,
 * как требует контракт. Без них субсхема не прошла бы валидацию при первом же
 * сохранении, и редактор встретил бы оператора списком ошибок вместо холста.
 */
function emptySubschemaGraph(): Record<string, unknown> {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "subschema",
    nodes: [
      { id: "start", type: "start", position: { x: 80, y: 160 }, config: { outputs: [] } },
      { id: "end", type: "end", position: { x: 480, y: 160 }, config: { inputs: [] } },
    ],
    connections: [],
  };
}

@Injectable()
export class WorkflowSubschemaService {
  constructor(private readonly database: PgDatabase) {}

  async listSubschemas(organizationId: string): Promise<WorkflowSubschemaResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<WorkflowSubschemaRow>(
        `
          SELECT id, organization_id, slug, name, schema, status, created_at, updated_at
          FROM workflow_subschemas
          WHERE organization_id = $1
          ORDER BY name ASC, slug ASC
        `,
        [organizationId],
      );

      return result.rows.map(mapWorkflowSubschema);
    });
  }

  /**
   * Создание субсхемы (дефект D3). Заводится пустой заготовкой вида `subschema`:
   * граф наполняется редактором через PATCH, как и у любой другой схемы.
   *
   * Статус `draft`: `sub_schema` ссылается только на активные субсхемы, и новая,
   * ещё пустая, не должна немедленно стать доступной для ссылок.
   */
  async createSubschema(
    organizationId: string,
    payload: CreateWorkflowSubschemaDto,
  ): Promise<WorkflowSubschemaResponseDto> {
    const slug = payload.slug.trim();
    const name = payload.name.trim();

    return this.database.withTenant(organizationId, async (client) => {
      const duplicate = await client.query(
        `SELECT 1 FROM workflow_subschemas WHERE organization_id = $1 AND slug = $2 LIMIT 1`,
        [organizationId, slug],
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        throw new ConflictException({
          code: "WORKFLOW_SUBSCHEMA_SLUG_TAKEN",
          description: `Subschema with slug ${slug} already exists.`,
          humanMessage: `Субсхема с идентификатором «${slug}» уже есть.`,
        });
      }

      const result = await client.query<WorkflowSubschemaRow>(
        `
          INSERT INTO workflow_subschemas (
            id, organization_id, slug, name, schema, status, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, 'draft', now(), now())
          RETURNING id, organization_id, slug, name, schema, status, created_at, updated_at
        `,
        [randomUUID(), organizationId, slug, name, JSON.stringify(emptySubschemaGraph())],
      );

      return mapWorkflowSubschema(result.rows[0]);
    });
  }

  /**
   * Изменение субсхемы (дефект D3).
   *
   * Граф проверяется ПОЛНОСТЬЮ, а не по форме: у субсхемы нет драфта и промоута —
   * узел `sub_schema` ссылается на неё по slug и подхватывает актуальный граф, то
   * есть любое сохранение сразу становится боевым. Послабление A10 для драфтов
   * здесь неприменимо: недостроенную субсхему сохранить нельзя, иначе она обрушит
   * уже работающие схемы.
   *
   * `slug` не меняется: на него ссылаются графы, которые живут дольше редактора.
   */
  async updateSubschema(
    organizationId: string,
    subschemaId: string,
    payload: UpdateWorkflowSubschemaDto,
  ): Promise<WorkflowSubschemaResponseDto> {
    const nextName = payload.name?.trim();

    if (payload.schema !== undefined) {
      // Вид графа контракт читает из самого графа (`kind: "subschema"`), а не из
      // параметра: субсхема, сохранённая как `workflow`, не имела бы границ
      // start/end, и это должно падать здесь, а не в рантайме у ссылающейся схемы.
      const validation = validateWorkflowSchema(payload.schema);
      if (!validation.valid) {
        throw createWorkflowSchemaValidationException(validation.errors);
      }
    }

    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<WorkflowSubschemaRow>(
        `
          UPDATE workflow_subschemas
          SET name = CASE WHEN $3 THEN $4 ELSE name END,
              schema = CASE WHEN $5 THEN $6::jsonb ELSE schema END,
              status = CASE WHEN $7 THEN $8 ELSE status END,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, slug, name, schema, status, created_at, updated_at
        `,
        [
          organizationId,
          subschemaId,
          nextName !== undefined,
          nextName ?? null,
          payload.schema !== undefined,
          payload.schema !== undefined ? JSON.stringify(payload.schema) : null,
          payload.status !== undefined,
          payload.status ?? null,
        ],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException({
          code: "WORKFLOW_SUBSCHEMA_NOT_FOUND",
          description: `Subschema ${subschemaId} was not found.`,
          humanMessage: "Субсхема не найдена.",
        });
      }

      return mapWorkflowSubschema(result.rows[0]);
    });
  }

  async findMissingActiveSlugs(
    client: Queryable,
    organizationId: string,
    slugs: string[],
  ): Promise<string[]> {
    if (slugs.length === 0) {
      return [];
    }

    const result = await client.query<{ slug: string }>(
      `
        SELECT slug
        FROM workflow_subschemas
        WHERE organization_id = $1
          AND status = 'active'
          AND slug = ANY($2::text[])
      `,
      [organizationId, slugs],
    );
    const found = new Set(result.rows.map((row) => row.slug));
    return slugs.filter((slug) => !found.has(slug));
  }
}
