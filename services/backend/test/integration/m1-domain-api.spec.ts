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
  database: "bridge_backend_test",
  password: "bridge_backend_test",
  user: "bridge_backend_test",
};
const ORG_A = "10000000-0000-4000-8000-000000000101";
const ORG_B = "10000000-0000-4000-8000-000000000102";
const USER_A = "10000000-0000-4000-8000-000000000201";
const USER_B = "10000000-0000-4000-8000-000000000202";
const CLIENT_A = "10000000-0000-4000-8000-000000000301";
const CLIENT_B = "10000000-0000-4000-8000-000000000302";
const ENDPOINT_A = "10000000-0000-4000-8000-000000000401";
const ENDPOINT_B = "10000000-0000-4000-8000-000000000402";
const CONVERSATION_A = "10000000-0000-4000-8000-000000000501";
const CONVERSATION_B = "10000000-0000-4000-8000-000000000502";
const MESSAGE_A = "10000000-0000-4000-8000-000000000601";
const MESSAGE_B = "10000000-0000-4000-8000-000000000602";
const IDEMPOTENCY_KEY = "10000000-0000-4000-8000-000000000777";

describe("SVC-API M1 domain API", () => {
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
    await seedTenantSlices(databaseUrl);

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

  it("serves organization CRUD, configuration history, users, and audit events", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/organizations/${ORG_A}`)
      .set("x-actor-user-id", USER_A)
      .send({ description: "Updated tenant A", locale: "en-US" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.description).toBe("Updated tenant A");
        expect(body.locale).toBe("en-US");
      });

    await request(app.getHttpServer())
      .put(`/api/v1/organizations/${ORG_A}/configuration`)
      .set("x-actor-user-id", USER_A)
      .send({ value: { ai: { enabled: true } } })
      .expect(200)
      .expect(({ body }) => {
        expect(body.key).toBe("default");
        expect(body.version).toBe(1);
      });

    await request(app.getHttpServer())
      .put(`/api/v1/organizations/${ORG_A}/configuration`)
      .set("x-actor-user-id", USER_A)
      .send({ value: { ai: { enabled: false } } })
      .expect(200)
      .expect(({ body }) => {
        expect(body.version).toBe(2);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/organizations/${ORG_A}/users`)
      .set("x-actor-user-id", USER_A)
      .send({
        displayName: "New Manager",
        email: "new-manager@example.bridge.local",
        roleCodes: ["manager"],
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.roleCodes).toEqual(["manager"]);
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${USER_A}`)
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({ status: "blocked" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe("blocked");
      });

    await withClient(databaseUrl, async (client) => {
      await setTenant(client, ORG_A);
      const history = await client.query<{ value: { ai: { enabled: boolean } }; version: number }>(
        `
          SELECT version, value
          FROM configuration_history
          WHERE organization_id = $1 AND config_key = 'default'
          ORDER BY version
        `,
        [ORG_A],
      );
      expect(history.rows.map((row) => [row.version, row.value.ai.enabled])).toEqual([
        [1, true],
        [2, false],
      ]);

      const audit = await client.query(
        "SELECT action FROM audit_events WHERE organization_id = $1 ORDER BY created_at, action",
        [ORG_A],
      );
      expect(audit.rows.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "configuration.put",
          "organization.update",
          "user.create",
          "user.patch",
        ]),
      );
    });
  });

  it("serves client CRUD, notes, tags, validation errors, and tenant isolation", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/clients")
      .set("x-organization-id", ORG_A)
      .send({ displayName: "   " })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("VALIDATION_FAILED");
      });

    const createdClient = await request(app.getHttpServer())
      .post("/api/v1/clients")
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({ displayName: "API Client" })
      .expect(201)
      .then((response) => response.body as { id: string });

    await request(app.getHttpServer())
      .get("/api/v1/clients")
      .set("x-organization-id", ORG_A)
      .expect(200)
      .expect(({ body }) => {
        const ids = body.items.map((client: { id: string }) => client.id);
        expect(ids).toContain(CLIENT_A);
        expect(ids).toContain(createdClient.id);
        expect(ids).not.toContain(CLIENT_B);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/clients/${createdClient.id}`)
      .set("x-organization-id", ORG_B)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/v1/clients/${createdClient.id}/notes`)
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({ body: "Call back after 18:00." })
      .expect(201)
      .expect(({ body }) => {
        expect(body.clientId).toBe(createdClient.id);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/clients/${createdClient.id}/tags`)
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({ tag: "vip" })
      .expect(201)
      .expect(({ body }) => {
        expect(body.tag).toBe("vip");
      });

    await request(app.getHttpServer())
      .post(`/api/v1/clients/${createdClient.id}/endpoints`)
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({ channel: "web_chat", externalId: "api-client-session", verified: true })
      .expect(201)
      .expect(({ body }) => {
        expect(body.channel).toBe("web_chat");
        expect(body.verified).toBe(true);
      });

    await request(app.getHttpServer())
      .post("/api/v1/clients:merge")
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .send({
        reason: "Duplicate web-chat contact",
        sourceClientId: createdClient.id,
        targetClientId: CLIENT_A,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.accepted).toBe(true);
        expect(body.mode).toBe("mock-core");
      });

    await withClient(databaseUrl, async (client) => {
      await setTenant(client, ORG_A);
      const audit = await client.query(
        "SELECT action FROM audit_events WHERE organization_id = $1 AND object_id = $2",
        [ORG_A, createdClient.id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual(
        expect.arrayContaining(["client.create", "client.note.create", "client.tag.create"]),
      );
    });
  });

  it("proxies conversations and idempotent messages through the CORE adapter", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/conversations")
      .set("x-organization-id", ORG_A)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toContain(CONVERSATION_A);
        expect(body.items.map((item: { id: string }) => item.id)).not.toContain(CONVERSATION_B);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/conversations/${CONVERSATION_A}/messages`)
      .set("x-organization-id", ORG_A)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toEqual([MESSAGE_A]);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/messages/${MESSAGE_A}`)
      .set("x-organization-id", ORG_B)
      .expect(404);

    const messagePayload = {
      content: { text: "Manager reply" },
      conversationId: CONVERSATION_A,
      endpointId: ENDPOINT_A,
    };

    const first = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .set("idempotency-key", IDEMPOTENCY_KEY)
      .send(messagePayload)
      .expect(201)
      .then((response) => response.body as { id: string; sequenceNumber: number });

    await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("x-organization-id", ORG_A)
      .set("x-actor-user-id", USER_A)
      .set("idempotency-key", IDEMPOTENCY_KEY)
      .send(messagePayload)
      .expect(201)
      .expect("x-idempotency-replayed", "true")
      .expect(({ body }) => {
        expect(body.id).toBe(first.id);
        expect(body.sequenceNumber).toBe(first.sequenceNumber);
      });

    await withClient(databaseUrl, async (client) => {
      await setTenant(client, ORG_A);
      const messages = await client.query(
        "SELECT id FROM messages WHERE organization_id = $1 AND id = $2",
        [ORG_A, first.id],
      );
      expect(messages.rowCount).toBe(1);
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

async function withClient<T>(databaseUrl: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function setTenant(client: PoolClient, organizationId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
    organizationId,
  ]);
  await client.query("SELECT set_config('app.is_platform_operator', 'false', false)");
}

async function seedTenantSlices(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await insertTenantSlice(client, {
      clientId: CLIENT_A,
      conversationId: CONVERSATION_A,
      endpointId: ENDPOINT_A,
      messageId: MESSAGE_A,
      organizationId: ORG_A,
      suffix: "a",
      userId: USER_A,
    });
    await insertTenantSlice(client, {
      clientId: CLIENT_B,
      conversationId: CONVERSATION_B,
      endpointId: ENDPOINT_B,
      messageId: MESSAGE_B,
      organizationId: ORG_B,
      suffix: "b",
      userId: USER_B,
    });
  });
}

async function insertTenantSlice(
  client: PoolClient,
  fixture: {
    clientId: string;
    conversationId: string;
    endpointId: string;
    messageId: string;
    organizationId: string;
    suffix: string;
    userId: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO organizations (id, name, description, timezone, locale, status)
      VALUES ($1, $2, $3, 'UTC', 'ru-RU', 'active')
    `,
    [fixture.organizationId, `Tenant ${fixture.suffix.toUpperCase()}`, "M1 API fixture"],
  );
  await client.query(
    `
      INSERT INTO users (id, organization_id, telegram_username, email, display_name, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
    `,
    [
      fixture.userId,
      fixture.organizationId,
      `manager_${fixture.suffix}`,
      `manager-${fixture.suffix}@example.bridge.local`,
      `Manager ${fixture.suffix.toUpperCase()}`,
    ],
  );
  await client.query(
    `
      INSERT INTO user_roles (user_id, role_id, organization_id)
      SELECT $1, id, $2 FROM roles WHERE code = 'manager'
    `,
    [fixture.userId, fixture.organizationId],
  );
  await client.query(
    "INSERT INTO clients (id, organization_id, display_name) VALUES ($1, $2, $3)",
    [fixture.clientId, fixture.organizationId, `Client ${fixture.suffix.toUpperCase()}`],
  );
  await client.query(
    `
      INSERT INTO communication_endpoints (
        id,
        organization_id,
        client_id,
        channel,
        external_id,
        verified,
        verified_at,
        metadata
      )
      VALUES ($1, $2, $3, 'web_chat', $4, true, '2026-01-01T00:00:00.000Z', '{}'::jsonb)
    `,
    [fixture.endpointId, fixture.organizationId, fixture.clientId, `web-chat-${fixture.suffix}`],
  );
  await client.query(
    `
      INSERT INTO conversations (
        id,
        organization_id,
        client_id,
        status,
        last_message_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'open',
        '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z'
      )
    `,
    [fixture.conversationId, fixture.organizationId, fixture.clientId],
  );
  await client.query(
    `
      INSERT INTO messages (
        id,
        organization_id,
        conversation_id,
        endpoint_id,
        channel,
        direction,
        sender_type,
        sequence_number,
        type,
        content,
        status,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'web_chat',
        'inbound',
        'client',
        1,
        'text',
        '{"text":"hello"}'::jsonb,
        'received',
        '2026-01-01T00:00:01.000Z'
      )
    `,
    [fixture.messageId, fixture.organizationId, fixture.conversationId, fixture.endpointId],
  );
}
