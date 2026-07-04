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
  database: "bridge_identity_m4_test",
  password: "bridge_identity_m4_test",
  user: "bridge_identity_m4_test",
};
const DEMO_ORG = "00000000-0000-4000-8000-000000000101";
const PLATFORM_USER = "40000000-0000-4000-8000-000000000201";
const PLATFORM_TOKEN = "brs_identity_m4_platform";

describe("SVC-IDN M4 self-service bootstrap and invitations", () => {
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
    await seedPlatformOperator(databaseUrl);

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

  it("provisions tenant, activates first admin once, creates manager invitation, and audits each step", async () => {
    const organization = await request(app.getHttpServer())
      .post("/api/v1/platform/organizations")
      .set("authorization", `Bearer ${PLATFORM_TOKEN}`)
      .send({
        description: "M4 integration tenant",
        name: "M4 Integration Tenant",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.name).toBe("M4 Integration Tenant");
        expect(body.status).toBe("active");
      })
      .then((response) => response.body as { id: string });

    const firstAdminInvitation = await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${organization.id}/administrators`)
      .set("authorization", `Bearer ${PLATFORM_TOKEN}`)
      .send({
        contactType: "email",
        contactValue: "m4-admin@example.bridge.local",
        displayName: "M4 Admin",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.organizationId).toBe(organization.id);
        expect(body.roleCode).toBe("administrator");
        expect(body.token).toMatch(/^bri_/);
      })
      .then((response) => response.body as { id: string; token: string });

    await withClient(databaseUrl, async (client) => {
      await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
      const persisted = await client.query<{ token_hash: string }>(
        "SELECT token_hash FROM invitations WHERE id = $1",
        [firstAdminInvitation.id],
      );
      expect(persisted.rows[0].token_hash).toMatch(/^sha256:/);
      expect(persisted.rows[0].token_hash).not.toBe(firstAdminInvitation.token);
    });

    const adminSession = await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        displayName: "Accepted M4 Admin",
        token: firstAdminInvitation.token,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.implementationStage).toBe("M4");
        expect(body.user.email).toBe("m4-admin@example.bridge.local");
        expect(body.roles).toEqual(["administrator"]);
        expect(body.token).toMatch(/^brs_/);
      })
      .expect(({ headers }) => {
        expect(headers["set-cookie"]?.[0]).toContain("bridge_session=");
        expect(headers["set-cookie"]?.[0]).toContain("HttpOnly");
      })
      .then((response) => response.body as { token: string; user: { id: string } });

    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        displayName: "Accepted M4 Admin",
        token: firstAdminInvitation.token,
      })
      .expect(401);

    const managerInvitation = await request(app.getHttpServer())
      .post("/api/v1/invitations")
      .set("authorization", `Bearer ${adminSession.token}`)
      .send({
        contactType: "telegram",
        contactValue: "@M4_Manager",
        organizationId: organization.id,
        roleCode: "manager",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.createdBy).toBe(adminSession.user.id);
        expect(body.roleCode).toBe("manager");
        expect(body.token).toMatch(/^bri_/);
      })
      .then((response) => response.body as { token: string });

    await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .send({
        displayName: "M4 Manager",
        token: managerInvitation.token,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.user.telegramUsername).toBe("m4_manager");
        expect(body.roles).toEqual(["manager"]);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/platform/organizations/${organization.id}/block`)
      .set("authorization", `Bearer ${PLATFORM_TOKEN}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe("blocked");
      });

    await withClient(databaseUrl, async (client) => {
      await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
      const audit = await client.query<{ action: string }>(
        `
          SELECT action
          FROM audit_events
          WHERE organization_id = $1
          ORDER BY created_at, action
        `,
        [organization.id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "auth.login.success",
          "invitation.accept",
          "invitation.create",
          "organization.block",
          "organization.provision",
        ]),
      );
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

async function seedPlatformOperator(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO users (id, organization_id, telegram_username, email, display_name, status)
        VALUES ($1, $2, 'platform_operator', 'platform@example.bridge.local', 'Platform Operator', 'active')
      `,
      [PLATFORM_USER, DEMO_ORG],
    );
    await client.query(
      `
        INSERT INTO user_roles (user_id, role_id, organization_id)
        SELECT $1, id, $2 FROM roles WHERE code = 'platform_operator'
      `,
      [PLATFORM_USER, DEMO_ORG],
    );
    await client.query(
      `
        INSERT INTO auth_sessions (id, user_id, organization_id, token_hash, issued_at, expires_at)
        VALUES (
          '40000000-0000-4000-8000-000000000901',
          $1,
          $2,
          $3,
          '2026-07-03T10:00:00.000Z',
          '2099-01-01T00:00:00.000Z'
        )
      `,
      [PLATFORM_USER, DEMO_ORG, hashSessionToken(PLATFORM_TOKEN)],
    );
  });
}

function hashSessionToken(token: string): string {
  return `sha256:${createHmac("sha256", "bridge-local-dev-auth-secret")
    .update(`auth_session:server:${token}`)
    .digest("hex")}`;
}
