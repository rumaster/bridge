import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

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
    [
      "unknown node type",
      {
        entry: "start",
        nodes: [{ id: "start", type: "sql-exec", config: {} }],
        schema_version: "1.0.0",
      },
      "$.nodes[0].type",
    ],
    [
      "forbidden transform operation",
      {
        entry: "start",
        nodes: [
          {
            config: {
              expression: { args: [{ op: "lit", value: "code" }], op: "eval" },
            },
            id: "start",
            type: "transform",
          },
        ],
        schema_version: "1.0.0",
      },
      "$.nodes[0].config.expression.op",
    ],
    [
      "cycle",
      {
        connections: [
          { from: "start", to: "call" },
          { from: "call", to: "start" },
        ],
        entry: "start",
        nodes: [
          { id: "start", type: "transform", config: { expression: { op: "input" } } },
          {
            config: { body: { op: "input" }, method: "POST", path: "/api/v1/records" },
            id: "call",
            type: "backend-api",
          },
        ],
        schema_version: "1.0.0",
      },
      "$.connections",
    ],
    [
      "tenant override",
      {
        entry: "call",
        nodes: [
          {
            config: {
              body: { op: "input" },
              method: "POST",
              organization_id: "00000000-0000-4000-8000-000000000999",
              path: "/api/v1/records",
            },
            id: "call",
            type: "backend-api",
          },
        ],
        schema_version: "1.0.0",
      },
      "$.nodes[0].config.organization_id",
    ],
    [
      "sub_schema embedded bodyGraph",
      {
        entry: "shared",
        nodes: [
          {
            config: {
              bodyGraph: { connections: [], nodes: [] },
              subSchemaSlug: "support-common-context",
            },
            id: "shared",
            type: "sub_schema",
          },
        ],
        schema_version: "1.0.0",
      },
      "$.nodes[0].config.bodyGraph",
    ],
    [
      "missing active sub_schema",
      {
        entry: "shared",
        nodes: [
          {
            config: {
              subSchemaSlug: "missing-subschema",
            },
            id: "shared",
            type: "sub_schema",
          },
        ],
        schema_version: "1.0.0",
      },
      "$.nodes[].config.subSchemaSlug",
    ],
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
      version_no: 1,
      workflow_id: WORKFLOW_ID,
    });

    await expect(readDefaultVersionId(databaseUrl)).resolves.toBe(version.id);
  });

  it("rejects an invalid draft before writing it to workflows", async () => {
    await expect(
      service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, {
        schema: {
          entry: "start",
          nodes: [{ id: "start", type: "sql-exec", config: {} }],
          schema_version: "1.0.0",
        },
      }),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "$.nodes[0].type",
          }),
        ]),
      }),
    });

    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual({
      draft_schema: null,
      draft_updated_at: null,
    });
  });

  it("rejects a draft with missing active sub_schema before writing it to workflows", async () => {
    await expect(
      service.saveDraft(ORG_ID, DRAFT_WORKFLOW_ID, {
        schema: validWorkflowSchema("draft-missing-sub-schema", "missing-subschema"),
      }),
    ).rejects.toMatchObject({
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

    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual({
      draft_schema: null,
      draft_updated_at: null,
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
          schema: {
            entry: "start",
            nodes: [{ id: "start", type: "sql-exec", config: {} }],
            schema_version: "1.0.0",
          },
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      name: "BadRequestException",
      response: expect.objectContaining({
        code: "WORKFLOW_SCHEMA_INVALID",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "$.nodes[0].type",
          }),
        ]),
      }),
    });

    await expect(readWorkflowDraft(databaseUrl, DRAFT_WORKFLOW_ID)).resolves.toEqual(
      draftBeforeImport,
    );
  });
});

function validWorkflowSchema(
  nodeId = "start",
  subSchemaSlug = "support-common-context",
): Record<string, unknown> {
  return {
    entry: nodeId,
    nodes: [
      {
        config: {
          subSchemaSlug,
        },
        id: nodeId,
        type: "sub_schema",
      },
    ],
    schema_version: "1.0.0",
  };
}

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
      [
        ORG_ID,
        JSON.stringify({
          connections: [],
          entry: "start",
          nodes: [
            {
              config: { expression: { op: "input" } },
              id: "start",
              type: "transform",
            },
          ],
          schema_version: "1.0.0",
        }),
      ],
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
      [
        randomUUID(),
        ORG_ID,
        slug,
        `Workflow subschema ${slug}`,
        JSON.stringify({
          connections: [],
          entry: "start",
          nodes: [
            {
              config: { expression: { op: "input" } },
              id: "start",
              type: "transform",
            },
          ],
          schema_version: "1.0.0",
        }),
        status,
      ],
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
