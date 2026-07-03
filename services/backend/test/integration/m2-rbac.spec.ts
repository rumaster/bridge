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
  database: "bridge_backend_rbac_test",
  password: "bridge_backend_rbac_test",
  user: "bridge_backend_rbac_test",
};
const ORG_A = "20000000-0000-4000-8000-000000000101";
const ORG_B = "20000000-0000-4000-8000-000000000102";
const ADMIN_A = "20000000-0000-4000-8000-000000000201";
const MANAGER_A = "20000000-0000-4000-8000-000000000202";
const CLIENT_A = "20000000-0000-4000-8000-000000000301";
const ADMIN_TOKEN = "brs_rbac_admin";
const MANAGER_TOKEN = "brs_rbac_manager";

describe("SVC-IDN M2 RBAC", () => {
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
    await seedRbacFixtures(databaseUrl);

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

  it("returns 401 when a protected domain endpoint has no session", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/clients")
      .set("x-organization-id", ORG_A)
      .expect(401);
  });

  it("returns 403 when Manager calls an administrative endpoint", async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/organizations/${ORG_A}/configuration`)
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .send({ value: { ai: { enabled: true } } })
      .expect(403);
  });

  it("allows Manager customer-work endpoints and keeps tenant scope authoritative", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/clients")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toContain(CLIENT_A);
      });

    await request(app.getHttpServer())
      .get("/api/v1/clients")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_B)
      .expect(403);
  });

  it("allows Administrator administrative endpoints", async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/organizations/${ORG_A}/configuration`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-actor-user-id", ADMIN_A)
      .send({ value: { ai: { enabled: false } } })
      .expect(200)
      .expect(({ body }) => {
        expect(body.organizationId).toBe(ORG_A);
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
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
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

async function seedRbacFixtures(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await insertOrganization(client, ORG_A, "Tenant A");
    await insertOrganization(client, ORG_B, "Tenant B");
    await insertUser(client, ADMIN_A, ORG_A, "admin_a", "Administrator A");
    await insertUser(client, MANAGER_A, ORG_A, "manager_a", "Manager A");
    await bindRole(client, ADMIN_A, ORG_A, "administrator");
    await bindRole(client, MANAGER_A, ORG_A, "manager");
    await insertSession(client, "20000000-0000-4000-8000-000000000901", ADMIN_A, ORG_A, ADMIN_TOKEN);
    await insertSession(
      client,
      "20000000-0000-4000-8000-000000000902",
      MANAGER_A,
      ORG_A,
      MANAGER_TOKEN,
    );
    await client.query(
      "INSERT INTO clients (id, organization_id, display_name) VALUES ($1, $2, $3)",
      [CLIENT_A, ORG_A, "RBAC Client"],
    );
  });
}

async function insertOrganization(
  client: PoolClient,
  id: string,
  name: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO organizations (id, name, description, timezone, locale, status)
      VALUES ($1, $2, 'RBAC fixture', 'UTC', 'ru-RU', 'active')
    `,
    [id, name],
  );
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
    [
      id,
      organizationId,
      telegramUsername,
      `${telegramUsername}@example.bridge.local`,
      displayName,
    ],
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
