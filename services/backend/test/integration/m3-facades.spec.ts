import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import request from "supertest";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";

jest.setTimeout(300_000);

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const DB = {
  database: "bridge_backend_m3_test",
  password: "bridge_backend_m3_test",
  user: "bridge_backend_m3_test",
};
const ORG_A = "30000000-0000-4000-8000-000000000101";
const ADMIN_A = "30000000-0000-4000-8000-000000000201";
const MANAGER_A = "30000000-0000-4000-8000-000000000202";
const ADMIN_TOKEN = "brs_m3_admin";
const MANAGER_TOKEN = "brs_m3_manager";

function buildCommand(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract: "C4.AiOnboardingCommand",
    version: "1.0.0",
    command_id: `cmd-${action}`,
    organization_id: ORG_A,
    action,
    params,
    safety: {
      apply_mode: "backend_validation_required",
      requires_confirmation: false,
      notes: [],
    },
    source: { prompt: "настрой", generated_by: "deterministic-mock-ai" },
    created_at: "2026-07-03T10:00:00.000Z",
  };
}

describe("SVC-API M3 facades (C4/C5)", () => {
  let app: INestApplication;
  let container: StartedTestContainer;
  let databaseUrl: string;

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

    runRootScript("scripts/db-migrate.mjs", ["up"], databaseUrl);
    runRootScript("scripts/db-seed.mjs", [], databaseUrl);
    await seedFixtures(databaseUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    delete process.env.DATABASE_URL;
  });

  it("degrades the AI assistant facade when SVC-AI is not wired (conversation keeps working)", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/assistant:suggest")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({ query: "Как оформить возврат заказа?" })
      .expect(201)
      .expect(({ body }) => {
        expect(body.degraded).toBe(true);
        expect(body.fallback_reason).toBe("unavailable");
        expect(body.suggestion.mode).toBe("fallback");
      });
  });

  it("degrades the FBP start-workflow facade when SVC-FBP is not wired", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/fbp/workflows/${ORG_A}:start`)
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({ workflow_version_id: ORG_A, actor_user_id: MANAGER_A })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe("degraded");
        expect(body.degraded).toBe(true);
        expect(body.fallback_reason).toBe("unavailable");
      });
  });

  it("applies a confirmed AI onboarding command through the Backend and audits actor_type = ai", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/onboarding:apply")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({
        command: buildCommand("configuration.upsert", {
          key: "organization.timezone",
          value: { timezone: "Europe/Moscow" },
        }),
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.applied).toBe(true);
        expect(body.status).toBe("applied");
        expect(body.detail.key).toBe("organization.timezone");
      });

    const audits = await auditRows(databaseUrl, "ai_onboarding.apply");
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_type).toBe("ai");
    expect(audits[0].result).toBe("success");
  });

  it("rejects the AI onboarding apply for a manager (no administrator rights)", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/onboarding:apply")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({ command: buildCommand("configuration.upsert", { value: { ai: { enabled: true } } }) })
      .expect(403);
  });

  it("applies a Workflow node change through the Backend and audits actor_type = workflow", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/workflows/backend-api-node:invoke")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({
        workflow_id: "30000000-0000-4000-8000-000000000401",
        workflow_version_id: "30000000-0000-4000-8000-000000000402",
        instance_id: "30000000-0000-4000-8000-000000000403",
        node_id: "apply-configuration",
        context: {
          organization_id: ORG_A,
          actor_user_id: ADMIN_A,
          trigger: "workflow",
        },
        command: buildCommand("configuration.upsert", {
          key: "workflow.greeting",
          value: { text: "Привет!" },
        }),
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.contract).toBe("C5.BackendApiNodeResult");
        expect(body.applied).toBe(true);
        expect(body.detail.key).toBe("workflow.greeting");
      });

    const audits = await auditRows(databaseUrl, "workflow.backend_api_node");
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_type).toBe("workflow");
    expect(audits[0].actor_user_id).toBe(ADMIN_A);
  });

  it("rejects a structurally invalid onboarding command (§12.6)", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/ai/onboarding:apply")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({ command: { contract: "wrong", action: "configuration.upsert" } })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("COMMAND_INVALID");
      });
  });
});

function connectionString(container: StartedTestContainer): string {
  return `postgres://${DB.user}:${DB.password}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB.database}`;
}

function runRootScript(scriptPath: string, args: string[], databaseUrl: string): void {
  execFileSync("node", [scriptPath, ...args], {
    cwd: resolve(__dirname, "../../../.."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
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

async function auditRows(
  databaseUrl: string,
  action: string,
): Promise<Array<{ actor_type: string; actor_user_id: string | null; result: string }>> {
  return withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    const result = await client.query<{
      actor_type: string;
      actor_user_id: string | null;
      result: string;
    }>(
      "SELECT actor_type, actor_user_id, result FROM audit_events WHERE action = $1 ORDER BY created_at",
      [action],
    );
    return result.rows;
  });
}

async function seedFixtures(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'M3 Tenant', 'M3 fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG_A],
    );
    await insertUser(client, ADMIN_A, ORG_A, "m3_admin", "Administrator M3");
    await insertUser(client, MANAGER_A, ORG_A, "m3_manager", "Manager M3");
    await bindRole(client, ADMIN_A, ORG_A, "administrator");
    await bindRole(client, MANAGER_A, ORG_A, "manager");
    await insertSession(client, "30000000-0000-4000-8000-000000000901", ADMIN_A, ORG_A, ADMIN_TOKEN);
    await insertSession(
      client,
      "30000000-0000-4000-8000-000000000902",
      MANAGER_A,
      ORG_A,
      MANAGER_TOKEN,
    );
  });
}

async function insertUser(
  client: PoolClient,
  id: string,
  organizationId: string,
  telegramUsername: string,
  displayName: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO users (id, organization_id, telegram_username, email, display_name, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
    `,
    [id, organizationId, telegramUsername, `${telegramUsername}@example.bridge.local`, displayName],
  );
}

async function bindRole(
  client: PoolClient,
  userId: string,
  organizationId: string,
  roleCode: "administrator" | "manager",
): Promise<void> {
  await client.query(
    `
      INSERT INTO user_roles (user_id, role_id, organization_id)
      SELECT $1, id, $2 FROM roles WHERE code = $3
    `,
    [userId, organizationId, roleCode],
  );
}

async function insertSession(
  client: PoolClient,
  id: string,
  userId: string,
  organizationId: string,
  token: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO auth_sessions (id, user_id, organization_id, token_hash, issued_at, expires_at)
      VALUES ($1, $2, $3, $4, '2026-07-03T10:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `,
    [id, userId, organizationId, hashSessionToken(token)],
  );
}

function hashSessionToken(token: string): string {
  return `sha256:${createHmac("sha256", "bridge-local-dev-auth-secret")
    .update(`auth_session:server:${token}`)
    .digest("hex")}`;
}
