import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { PgDatabase } from "../../src/common/database/database.service";
import { WorkflowSubschemaService } from "../../src/modules/workflow/workflow-subschema.service";
import { WorkflowService } from "../../src/modules/workflow/workflow.service";

jest.setTimeout(300_000);

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const DB = {
  database: "bridge_backend_workflow_validation_test",
  password: "bridge_backend_workflow_validation_test",
  user: "bridge_backend_workflow_validation_test",
};
const ORG_ID = "41000000-0000-4000-8000-000000000101";
const WORKFLOW_ID = "41000000-0000-4000-8000-000000000401";
const DRAFT_WORKFLOW_ID = "41000000-0000-4000-8000-000000000402";
const DRAFT_VERSION_ID = "41000000-0000-4000-8000-000000000412";
const PROMOTE_WORKFLOW_ID = "41000000-0000-4000-8000-000000000403";
const PROMOTE_VERSION_ID = "41000000-0000-4000-8000-000000000413";

/**
 * Ревизия 2026-07-15: схемы переведены на контракт 2.0 (решение A4) —
 * `{ schema_version: "2.0.0", kind, nodes, connections }`, узлы с `position`,
 * `entry` упразднён. Проверки whitelist Transform-выражений удалены вместе с
 * режимом `expression` (A8), а `bodyGraph` — вместе с самим концептом (D6).
 *
 * Ошибки контракта несут `nodeId`, поэтому путь ошибки узла — `$.nodes[id=X]`,
 * а не `$.nodes[<индекс>].<поле>`, как в 1.0.
 *
 * Операция Backend API берётся из каталога предикатом: каталог генерируется из
 * OpenAPI и переезжает вместе с API, хардкод id разъехался бы с ним.
 */
const CATALOG_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;

describe("WorkflowService createVersion validation", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  let database: PgDatabase;
  let service: WorkflowService;

  beforeAll(async () => {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: DB.database,
        POSTGRES_PASSWORD: DB.password,
        POSTGRES_USER: DB.user,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    databaseUrl = connectionString(container);
    process.env.DATABASE_URL = databaseUrl;
    runRootScript("scripts/db-migrate.ts", ["up"], databaseUrl);
    await seedWorkflow(databaseUrl);
    database = new PgDatabase();
    service = new WorkflowService(database, new WorkflowSubschemaService(database));
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await container?.stop();
    delete process.env.DATABASE_URL;
  });

  it.each([
    ["unknown node type", unknownNodeTypeSchema(), "$.nodes[id=bad]"],
    ["outdated schema version", outdatedSchema(), "$.schema_version"],
    ["exec cycle", cycleSchema(), "$.connections"],
    ["tenant override", tenantOverrideSchema(), "$.nodes[id=call]"],
    ["backend-api call outside the generated catalog", offCatalogSchema(), "$.nodes[id=call]"],
    ["workflow without an event source", withoutEventSourceSchema(), "$.nodes"],
    ["missing active sub_schema", validWorkflowSchema("shared", "missing-subschema"), "$.nodes[].config.subSchemaSlug"],
  ])("rejects an invalid schema before inserting a new immutable version: %s", async (_name, schema, errorPath) => {
    await expect(
      service.createVersion(
        ORG_ID,
        WORKFLOW_ID,
        {
          activate: true,
          schema,
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: errorPath,
          }),
        ]),
      }),
    });

    await expect(countWorkflowVersions(databaseUrl)).resolves.toBe(0);
  });

  /**
   * Регрессия дефекта D1: прежний валидатор Backend читал `connection.port`
   * вместо `fromPort` и схлопывал все исходящие связи узла в ключ `from+"out"`,
   * из-за чего узел ветвления с ОБЕИМИ ветками через API сохранить было нельзя.
   */
  it("persists a branch node wired to both true and false branches (D1 regression)", async () => {
    const version = await service.createVersion(
      ORG_ID,
      WORKFLOW_ID,
      {
        activate: true,
        schema: branchSchema(),
      },
      undefined,
    );

    expect(version).toMatchObject({
      organization_id: ORG_ID,
      schema: branchSchema(),
      version_no: 1,
      workflow_id: WORKFLOW_ID,
    });
    await expect(countWorkflowVersions(databaseUrl)).resolves.toBe(1);
  });

  it("persists a valid schema and activates it when requested", async () => {
    const version = await service.createVersion(
      ORG_ID,
      WORKFLOW_ID,
      {
        activate: true,
        schema: validWorkflowSchema(),
      },
      undefined,
    );

    expect(version).toMatchObject({
      organization_id: ORG_ID,
      schema: validWorkflowSchema(),
      version_no: 2,
      workflow_id: WORKFLOW_ID,
    });

    await expect(readDefaultVersionId(databaseUrl)).resolves.toBe(version.id);
  });

  /**
   * Витрина вызовов (решение A3) — уровень Backend, а не контракта: каталог
   * отвечает «что существует», витрина — «что platform_operator разрешил дёргать».
   * Проверяется при каждом сохранении, иначе закрытую в витрине операцию
   * продолжали бы звать уже сохранённые схемы.
   */
  it("rejects a backend-api call that is in the catalog but not enabled in the allowlist", async () => {
    await expect(
      service.createVersion(ORG_ID, WORKFLOW_ID, { activate: false, schema: backendApiSchema() }, undefined),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "$.nodes",
            message: expect.stringContaining(CATALOG_OP.operation_id),
          }),
        ]),
      }),
    });
  });

  it("persists a backend-api call once the operation is enabled in the allowlist", async () => {
    await setAllowlistOperation(databaseUrl, CATALOG_OP.operation_id, true);

    const version = await service.createVersion(
      ORG_ID,
      WORKFLOW_ID,
      { activate: false, schema: backendApiSchema() },
      undefined,
    );
    expect(version).toMatchObject({ schema: backendApiSchema(), workflow_id: WORKFLOW_ID });

    // Закрытие операции в витрине снова запрещает сохранение той же схемы.
    await setAllowlistOperation(databaseUrl, CATALOG_OP.operation_id, false);
    await expect(
      service.createVersion(ORG_ID, WORKFLOW_ID, { activate: false, schema: backendApiSchema() }, undefined),
    ).rejects.toMatchObject({ name: "BadRequestException" });
  });

  // Решение A10: драфт проверяется только по ФОРМЕ графа. Редактор сохраняет его
  // автоматически при выходе и при переходе к другой схеме — полная валидация
  // здесь молча теряла бы недостроенную работу. Полная проверка контракта живёт
  // в promoteDraft. См. docs/plan/workflow-2.0-redesign.md.
  it("сохраняет недостроенный драфт: автосохранение не должно терять работу", async () => {
    const unfinished = unknownNodeTypeSchema();

    await expect(service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, { schema: unfinished })).resolves.toMatchObject({
      has_draft: true,
    });

    const stored = await readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID);
    expect(stored.draft_schema).toEqual(unfinished);
    expect(stored.draft_updated_at).not.toBeNull();
  });

  it("но отвергает драфт, который вообще не является графом схемы, не тронув сохранённый", async () => {
    const before = await readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID);

    await expect(
      service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, { schema: { nodes: "нет" } as never }),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({ code: "WORKFLOW_SCHEMA_INVALID" }),
    });

    // Отвергнутое автосохранение не должно затирать то, что уже лежало.
    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual(before);
  });

  it("промоут недостроенного драфта отвергается — рабочая версия обязана быть валидной", async () => {
    await service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, { schema: unknownNodeTypeSchema() });

    await expect(service.promoteDraft(ORG_ID, DRAFT_WORKFLOW_ID, undefined)).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[id=bad]" })]),
      }),
    });
  });

  it("промоут драфта со ссылкой на неактивную субсхему отвергается", async () => {
    await service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, {
      schema: validWorkflowSchema("draft-missing-sub-schema", "missing-subschema"),
    });

    await expect(service.promoteDraft(ORG_ID, DRAFT_WORKFLOW_ID, undefined)).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({ code: "WORKFLOW_SCHEMA_INVALID" }),
    });
  });

  it("persists and resets a valid draft without creating an immutable version", async () => {
    const schema = validWorkflowSchema("draft-node");

    const saved = await service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, { schema });
    expect(saved).toMatchObject({
      has_draft: true,
      organization_id: ORG_ID,
      schema,
      workflow_id: DRAFT_WORKFLOW_ID,
    });
    expect(saved.draft_updated_at).toEqual(expect.any(String));

    await expect(service.getDraft(ORG_ID, DRAFT_WORKFLOW_ID)).resolves.toMatchObject({
      has_draft: true,
      schema,
      workflow_id: DRAFT_WORKFLOW_ID,
    });
    await expect(countWorkflowVersions(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toBe(1);

    const reset = await service.resetDraft(ORG_ID, DRAFT_WORKFLOW_ID);
    expect(reset).toMatchObject({
      has_draft: false,
      schema: null,
      workflow_id: DRAFT_WORKFLOW_ID,
    });
    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual({
      draft_schema: null,
      draft_updated_at: null,
    });
    await expect(countWorkflowVersions(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toBe(1);
  });

  it("rejects draft promotion when a referenced sub_schema is no longer active", async () => {
    const schema = validWorkflowSchema("inactive-sub-schema-draft", "draft-only-context");

    await insertWorkflowSubschema(databaseUrl, "draft-only-context", "active");
    await service.saveDraft(ORG_ID, PROMOTE_WORKFLOW_ID, { schema });
    await updateWorkflowSubschemaStatus(databaseUrl, "draft-only-context", "draft");

    await expect(service.promoteDraft(ORG_ID, PROMOTE_WORKFLOW_ID, undefined)).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "$.nodes[].config.subSchemaSlug",
          }),
        ]),
      }),
    });
    await expect(countWorkflowVersions(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toBe(1);
    await expect(readWorkflowDraft(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toMatchObject({
      draft_schema: schema,
      draft_updated_at: expect.any(String),
    });
  });

  it("promotes a draft into a new active immutable version and clears the draft", async () => {
    const schema = validWorkflowSchema("published-draft-node");

    await service.saveDraft(ORG_ID, PROMOTE_WORKFLOW_ID, { schema });
    const version = await service.promoteDraft(ORG_ID, PROMOTE_WORKFLOW_ID, undefined);

    expect(version).toMatchObject({
      organization_id: ORG_ID,
      schema,
      version_no: 2,
      workflow_id: PROMOTE_WORKFLOW_ID,
    });
    await expect(readDefaultVersionId(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toBe(version.id);
    await expect(readWorkflowDraft(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toEqual({
      draft_schema: null,
      draft_updated_at: null,
    });
    await expect(countWorkflowVersions(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toBe(2);
  });

  /** Promote заводит подписки узлов «Ожидание события» (решение A2). */
  it("registers event subscriptions for wait-event nodes on promotion", async () => {
    await expect(readEventSubscriptions(databaseUrl, PROMOTE_WORKFLOW_ID)).resolves.toEqual([
      { node_id: "evt", event_type: "message.created" },
    ]);
  });

  it("exports the active Workflow schema with metadata", async () => {
    const exported = await service.exportWorkflow(ORG_ID, DRAFT_WORKFLOW_ID);

    expect(exported).toMatchObject({
      contract: "C5.WorkflowSchemaExport",
      version: "1.0.0",
      workflow: {
        id: DRAFT_WORKFLOW_ID,
        name: "Workflow draft fixture",
        version_id: DRAFT_VERSION_ID,
        version_no: 1,
      },
      schema: validWorkflowSchema("seed-start"),
    });
    expect(exported.exported_at).toEqual(expect.any(String));
  });

  it("imports an exported Workflow schema into the persisted draft by default", async () => {
    const exported = await service.exportWorkflow(ORG_ID, DRAFT_WORKFLOW_ID);
    const schema = validWorkflowSchema("imported-draft-node");

    const imported = await service.importWorkflow(
      ORG_ID,
      DRAFT_WORKFLOW_ID,
      {
        ...exported,
        schema,
      },
      undefined,
    );

    expect(imported).toMatchObject({
      target: "draft",
      draft: {
        has_draft: true,
        schema,
        workflow_id: DRAFT_WORKFLOW_ID,
      },
    });
    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toMatchObject({
      draft_schema: schema,
      draft_updated_at: expect.any(String),
    });
    await expect(countWorkflowVersions(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toBe(1);
  });

  it("imports an exported Workflow schema as a new active version", async () => {
    const exported = await service.exportWorkflow(ORG_ID, DRAFT_WORKFLOW_ID);
    const draftBeforeImport = await readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID);
    const schema = validWorkflowSchema("imported-version-node");

    const imported = await service.importWorkflow(
      ORG_ID,
      DRAFT_WORKFLOW_ID,
      {
        ...exported,
        activate: true,
        schema,
        target: "version",
      },
      undefined,
    );

    expect(imported).toMatchObject({
      target: "version",
      version: {
        schema,
        version_no: 2,
        workflow_id: DRAFT_WORKFLOW_ID,
      },
    });
    expect(imported.version).toBeDefined();
    await expect(countWorkflowVersions(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toBe(2);
    await expect(readDefaultVersionId(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toBe(
      imported.version?.id,
    );
    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual(
      draftBeforeImport,
    );
  });

  it("rejects an imported invalid Workflow schema before writing the draft", async () => {
    const exported = await service.exportWorkflow(ORG_ID, DRAFT_WORKFLOW_ID);
    const draftBeforeImport = await readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID);

    await expect(
      service.importWorkflow(
        ORG_ID,
        DRAFT_WORKFLOW_ID,
        {
          ...exported,
          schema: unknownNodeTypeSchema(),
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "$.nodes[id=bad]",
          }),
        ]),
      }),
    });

    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual(
      draftBeforeImport,
    );
  });
});

// ---------------------------------------------------------------------------
// Схемы 2.0
// ---------------------------------------------------------------------------

/** Узел «Ожидание события» — источник исполнения, обязателен в kind: "workflow". */
function eventNode(): Record<string, unknown> {
  return {
    config: { event_type: "message.created" },
    id: "evt",
    position: { x: 0, y: 0 },
    type: "wait-event",
  };
}

function validWorkflowSchema(
  nodeId = "shared",
  subSchemaSlug = "support-common-context",
): Record<string, unknown> {
  return {
    connections: [{ from: "evt", fromPort: "out", id: "c1", to: nodeId, toPort: "in" }],
    kind: "workflow",
    nodes: [
      eventNode(),
      {
        config: { subSchemaSlug },
        id: nodeId,
        position: { x: 0, y: 0 },
        type: "sub_schema",
      },
    ],
    schema_version: "2.0.0",
  };
}

function unknownNodeTypeSchema(): Record<string, unknown> {
  return {
    connections: [],
    kind: "workflow",
    nodes: [eventNode(), { config: {}, id: "bad", position: { x: 0, y: 0 }, type: "sql-exec" }],
    schema_version: "2.0.0",
  };
}

function outdatedSchema(): Record<string, unknown> {
  return { ...validWorkflowSchema(), schema_version: "1.0.0" };
}

function withoutEventSourceSchema(): Record<string, unknown> {
  return {
    connections: [],
    kind: "workflow",
    nodes: [{ config: { code: "return 1;" }, id: "t", position: { x: 0, y: 0 }, type: "transform" }],
    schema_version: "2.0.0",
  };
}

function cycleSchema(): Record<string, unknown> {
  return {
    connections: [
      { from: "evt", fromPort: "out", id: "c1", to: "w1", toPort: "in" },
      { from: "w1", fromPort: "out", id: "c2", to: "w2", toPort: "in" },
      { from: "w2", fromPort: "out", id: "c3", to: "w1", toPort: "in" },
    ],
    kind: "workflow",
    nodes: [
      eventNode(),
      { config: { inputs: [{ name: "a", type: "any" }] }, id: "w1", position: { x: 0, y: 0 }, type: "variable_write" },
      { config: { inputs: [{ name: "a", type: "any" }] }, id: "w2", position: { x: 0, y: 0 }, type: "variable_write" },
    ],
    schema_version: "2.0.0",
  };
}

/** Узел не может подменить арендатора конфигом (§13.13-п.4). */
function tenantOverrideSchema(): Record<string, unknown> {
  return {
    connections: [{ from: "evt", fromPort: "out", id: "c1", to: "call", toPort: "in" }],
    kind: "workflow",
    nodes: [
      eventNode(),
      {
        config: {
          operation_id: CATALOG_OP.operation_id,
          organization_id: "00000000-0000-4000-8000-000000000999",
        },
        id: "call",
        position: { x: 0, y: 0 },
        type: "backend-api",
      },
    ],
    schema_version: "2.0.0",
  };
}

/** Произвольный путь задать нельзя: method/path приходят из каталога (решение A3). */
function offCatalogSchema(): Record<string, unknown> {
  return {
    connections: [{ from: "evt", fromPort: "out", id: "c1", to: "call", toPort: "in" }],
    kind: "workflow",
    nodes: [
      eventNode(),
      {
        config: { operation_id: "NoSuchOperationInCatalog" },
        id: "call",
        position: { x: 0, y: 0 },
        type: "backend-api",
      },
    ],
    schema_version: "2.0.0",
  };
}

function backendApiSchema(): Record<string, unknown> {
  return {
    connections: [{ from: "evt", fromPort: "out", id: "c1", to: "call", toPort: "in" }],
    kind: "workflow",
    nodes: [
      eventNode(),
      {
        config: { operation_id: CATALOG_OP.operation_id },
        id: "call",
        position: { x: 0, y: 0 },
        type: "backend-api",
      },
    ],
    schema_version: "2.0.0",
  };
}

/** Ветвление с ОБЕИМИ ветками — то, что дефект D1 сохранить не позволял. */
function branchSchema(): Record<string, unknown> {
  return {
    connections: [
      { from: "evt", fromPort: "out", id: "c1", to: "b", toPort: "in" },
      { from: "evt", fromPort: "data", id: "c2", to: "b", toPort: "value" },
      { from: "b", fromPort: "true", id: "c3", to: "yes", toPort: "in" },
      { from: "b", fromPort: "false", id: "c4", to: "no", toPort: "in" },
    ],
    kind: "workflow",
    nodes: [
      eventNode(),
      { config: { operator: "truthy" }, id: "b", position: { x: 0, y: 0 }, type: "branch" },
      { config: { inputs: [{ name: "hit", type: "any" }] }, id: "yes", position: { x: 0, y: 0 }, type: "variable_write" },
      { config: { inputs: [{ name: "hit", type: "any" }] }, id: "no", position: { x: 0, y: 0 }, type: "variable_write" },
    ],
    schema_version: "2.0.0",
  };
}

/** Субсхема: kind "subschema" обязана иметь ровно один start и один end. */
function subSchemaGraph(): Record<string, unknown> {
  return {
    connections: [{ from: "s", fromPort: "out", id: "c1", to: "e", toPort: "in" }],
    kind: "subschema",
    nodes: [
      { config: { outputs: [] }, id: "s", position: { x: 0, y: 0 }, type: "start" },
      { config: { inputs: [] }, id: "e", position: { x: 0, y: 0 }, type: "end" },
    ],
    schema_version: "2.0.0",
  };
}

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

function connectionString(container: StartedTestContainer): string {
  return `postgres://${DB.user}:${DB.password}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB.database}`;
}

function runRootScript(scriptPath: string, args: string[], databaseUrl: string): void {
  execFileSync("node", ["--import", "tsx", scriptPath, ...args], {
    cwd: resolve(__dirname, "../../../.."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

async function seedWorkflow(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Workflow Validation Tenant', 'Workflow validation fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG_ID],
    );
    await client.query(
      `
        INSERT INTO workflows (id, organization_id, name, status)
        VALUES ($1, $2, 'Workflow validation fixture', 'draft')
      `,
      [WORKFLOW_ID, ORG_ID],
    );
    await client.query(
      `
        INSERT INTO workflow_subschemas (id, organization_id, slug, name, schema, status)
        VALUES (
          '41000000-0000-4000-8000-000000000441',
          $1,
          'support-common-context',
          'Общий контекст поддержки',
          $2::jsonb,
          'active'
        )
      `,
      [ORG_ID, JSON.stringify(subSchemaGraph())],
    );
    await insertSeededWorkflowWithVersion(
      client,
      DRAFT_WORKFLOW_ID,
      DRAFT_VERSION_ID,
      "Workflow draft fixture",
    );
    await insertSeededWorkflowWithVersion(
      client,
      PROMOTE_WORKFLOW_ID,
      PROMOTE_VERSION_ID,
      "Workflow promote fixture",
    );
  });
}

async function insertSeededWorkflowWithVersion(
  client: PoolClient,
  workflowId: string,
  versionId: string,
  name: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO workflows (id, organization_id, name, status)
      VALUES ($1, $2, $3, 'active')
    `,
    [workflowId, ORG_ID, name],
  );
  await client.query(
    `
      INSERT INTO workflow_versions (id, organization_id, workflow_id, version_no, schema)
      VALUES ($1, $2, $3, 1, $4::jsonb)
    `,
    [versionId, ORG_ID, workflowId, JSON.stringify(validWorkflowSchema("seed-start"))],
  );
  await client.query(
    `
      UPDATE workflows
      SET default_version_id = $3
      WHERE organization_id = $1 AND id = $2
    `,
    [ORG_ID, workflowId, versionId],
  );
}

/** Витрина вызовов Backend API: пустая по умолчанию, операции открывает оператор. */
async function setAllowlistOperation(
  databaseUrl: string,
  operationId: string,
  enabled: boolean,
): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO workflow_backend_api_allowlist (operation_id, enabled)
        VALUES ($1, $2)
        ON CONFLICT (operation_id) DO UPDATE SET enabled = EXCLUDED.enabled, curated_at = now()
      `,
      [operationId, enabled],
    );
  });
}

async function insertWorkflowSubschema(
  databaseUrl: string,
  slug: string,
  status: "active" | "draft",
): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO workflow_subschemas (id, organization_id, slug, name, schema, status)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [randomUUID(), ORG_ID, slug, `Workflow subschema ${slug}`, JSON.stringify(subSchemaGraph()), status],
    );
  });
}

async function updateWorkflowSubschemaStatus(
  databaseUrl: string,
  slug: string,
  status: "active" | "draft",
): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        UPDATE workflow_subschemas
        SET status = $3,
            updated_at = now()
        WHERE organization_id = $1 AND slug = $2
      `,
      [ORG_ID, slug, status],
    );
  });
}

async function countWorkflowVersions(
  databaseUrl: string,
  workflowId = WORKFLOW_ID,
): Promise<number> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM workflow_versions WHERE workflow_id = $1",
      [workflowId],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

async function readDefaultVersionId(
  databaseUrl: string,
  workflowId = WORKFLOW_ID,
): Promise<null | string> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{ default_version_id: null | string }>(
      "SELECT default_version_id FROM workflows WHERE id = $1",
      [workflowId],
    );
    return result.rows[0]?.default_version_id ?? null;
  });
}

async function readEventSubscriptions(
  databaseUrl: string,
  workflowId: string,
): Promise<{ event_type: string; node_id: string }[]> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{ event_type: string; node_id: string }>(
      `
        SELECT node_id, event_type
        FROM workflow_event_subscriptions
        WHERE workflow_id = $1
        ORDER BY node_id
      `,
      [workflowId],
    );
    return result.rows.map((row) => ({ event_type: row.event_type, node_id: row.node_id }));
  });
}

async function readWorkflowDraft(
  databaseUrl: string,
  workflowId: string,
): Promise<{ draft_schema: null | Record<string, unknown>; draft_updated_at: null | string }> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{
      draft_schema: null | Record<string, unknown>;
      draft_updated_at: Date | null;
    }>(
      "SELECT draft_schema, draft_updated_at FROM workflows WHERE id = $1",
      [workflowId],
    );
    const row = result.rows[0];
    return {
      draft_schema: row?.draft_schema ?? null,
      draft_updated_at: row?.draft_updated_at?.toISOString() ?? null,
    };
  });
}

async function withClient<T>(
  databaseUrl: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
    await pool.end();
  }
}
