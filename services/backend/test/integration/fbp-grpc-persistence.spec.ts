import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { PgDatabase } from "../../src/common/database/database.service";
import { PgFbpWorkflowPersistence } from "../../src/modules/fbp-integration/fbp-grpc-upstream.client";
import type { FbpStartWorkflowFacadeResponse } from "../../src/modules/fbp-integration/fbp-integration.facade";

jest.setTimeout(300_000);

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const DB = {
  database: "bridge_backend_fbp_grpc_test",
  password: "bridge_backend_fbp_grpc_test",
  user: "bridge_backend_fbp_grpc_test",
};
const ORG_ID = "40000000-0000-4000-8000-000000000101";
const WORKFLOW_ID = "40000000-0000-4000-8000-000000000401";
const VERSION_ID = "40000000-0000-4000-8000-000000000402";
const INSTANCE_ID = "40000000-0000-4000-8000-000000000403";
const LOG_ID = "40000000-0000-4000-8000-000000000404";

describe("PgFbpWorkflowPersistence", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  let database: PgDatabase;

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
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await container?.stop();
    delete process.env.DATABASE_URL;
  });

  it("loads the Backend-owned workflow schema and persists real FBP execution state/logs", async () => {
    const persistence = new PgFbpWorkflowPersistence(database);
    const request = {
      actor_user_id: "manager-fbp-stage-2",
      input: { amount: 500 },
      organization_id: ORG_ID,
      request_id: "req-fbp-stage-2",
      workflow_id: WORKFLOW_ID,
      workflow_version_id: VERSION_ID,
    };

    const startContext = await persistence.loadStartContext(request);
    expect(startContext).toMatchObject({
      context: {
        actor_user_id: "manager-fbp-stage-2",
        organization_id: ORG_ID,
        trigger: "manual",
      },
      schema: {
        workflow_id: WORKFLOW_ID,
        workflow_version_id: VERSION_ID,
      },
    });
    expect(startContext.schema.nodes).toEqual([
      {
        config: { subSchemaSlug: "support-common-context" },
        id: "prepare",
        type: "sub_schema",
      },
    ]);
    expect(startContext.schema.__resolved_subschemas).toMatchObject({
      "support-common-context": {
        entry: "sub-start",
        nodes: [
          {
            config: { expression: { op: "input" } },
            id: "sub-start",
            type: "transform",
          },
        ],
      },
    });

    const response: FbpStartWorkflowFacadeResponse = {
      contract: "C5.StartWorkflowInstanceResponse",
      created_at: "2026-07-06T00:30:00.000Z",
      degraded: false,
      fallback_reason: null,
      instance_id: INSTANCE_ID,
      organization_id: ORG_ID,
      request_id: "req-fbp-stage-2",
      state: { output: { amount: 500 }, status: "completed" },
      state_changed_event: null,
      status: "completed",
      version: "1.0.0",
      workflow_id: WORKFLOW_ID,
      workflow_version_id: VERSION_ID,
    };

    await persistence.persistStartResult({
      journal: [
        {
          created_at: "2026-07-06T00:30:00.000Z",
          data: { message: "workflow completed" },
          event: "workflow.completed",
          id: LOG_ID,
          instance_id: INSTANCE_ID,
          node_id: null,
          organization_id: ORG_ID,
        },
      ],
      request,
      response,
    });

    await expect(readPersistedRows(databaseUrl)).resolves.toEqual({
      instance: {
        id: INSTANCE_ID,
        status: "completed",
        version_id: VERSION_ID,
        workflow_id: WORKFLOW_ID,
      },
      log: {
        event: "workflow.completed",
        id: LOG_ID,
      },
      state: {
        output: { amount: 500 },
        status: "completed",
      },
    });
  });
});

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
        VALUES ($1, 'FBP Stage 2 Tenant', 'FBP fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG_ID],
    );
    await client.query(
      `
        INSERT INTO workflows (id, organization_id, name, status)
        VALUES ($1, $2, 'Stage 2 workflow', 'active')
      `,
      [WORKFLOW_ID, ORG_ID],
    );
    await client.query(
      `
        INSERT INTO workflow_subschemas (id, organization_id, slug, name, schema, status)
        VALUES (
          '40000000-0000-4000-8000-000000000405',
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
          entry: "sub-start",
          nodes: [
            {
              config: { expression: { op: "input" } },
              id: "sub-start",
              type: "transform",
            },
          ],
          schema_version: "1.0.0",
        }),
      ],
    );
    await client.query(
      `
        INSERT INTO workflow_versions (id, organization_id, workflow_id, version_no, schema, created_by)
        VALUES ($1, $2, $3, 1, $4::jsonb, NULL)
      `,
      [
        VERSION_ID,
        ORG_ID,
        WORKFLOW_ID,
        JSON.stringify({
          entry: "prepare",
          nodes: [
            {
              config: { subSchemaSlug: "support-common-context" },
              id: "prepare",
              type: "sub_schema",
            },
          ],
          schema_version: "1.0.0",
        }),
      ],
    );
  });
}

async function readPersistedRows(databaseUrl: string): Promise<Record<string, unknown>> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const instances = await client.query(
      `
        SELECT id, workflow_id, version_id, status
        FROM workflow_instances
        WHERE id = $1
      `,
      [INSTANCE_ID],
    );
    const states = await client.query(
      `
        SELECT state
        FROM workflow_instance_state
        WHERE instance_id = $1
      `,
      [INSTANCE_ID],
    );
    const logs = await client.query(
      `
        SELECT id, event
        FROM workflow_execution_logs
        WHERE id = $1
      `,
      [LOG_ID],
    );

    return {
      instance: instances.rows[0],
      log: logs.rows[0],
      state: states.rows[0].state,
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
