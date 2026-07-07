import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { BadRequestException } from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { PgDatabase } from "../../src/common/database/database.service";
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
    service = new WorkflowService(database);
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
});

function validWorkflowSchema(): Record<string, unknown> {
  return {
    entry: "start",
    nodes: [
      {
        config: {
          expression: { op: "input" },
        },
        id: "start",
        type: "transform",
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
  });
}

async function countWorkflowVersions(databaseUrl: string): Promise<number> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM workflow_versions WHERE workflow_id = $1",
      [WORKFLOW_ID],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

async function readDefaultVersionId(databaseUrl: string): Promise<null | string> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{ default_version_id: null | string }>(
      "SELECT default_version_id FROM workflows WHERE id = $1",
      [WORKFLOW_ID],
    );
    return result.rows[0]?.default_version_id ?? null;
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
