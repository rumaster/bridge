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

const ORG = "20000000-0000-4000-8000-000000000101";
const INGRESS_MESSAGE = "20000000-0000-4000-8000-000000000601";
// Исходящее сообщение, заранее сохранённое как direction=outbound/status=routed
// (его создаёт communication-core при ответе оператора; здесь фиксируем фикстурой).
const OUT_CLIENT = "20000000-0000-4000-8000-000000000301";
const OUT_ENDPOINT = "20000000-0000-4000-8000-000000000401";
const OUT_CONVERSATION = "20000000-0000-4000-8000-000000000501";
const OUT_MESSAGE = "20000000-0000-4000-8000-000000000602";

function ingressEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: INGRESS_MESSAGE,
    message: {
      message_id: INGRESS_MESSAGE,
      organization_id: ORG,
      channel_id: "tg-bot-1",
      channel_type: "telegram",
      sender_ref: "tg-user-42",
      direction: "inbound",
      occurred_at: "2026-07-04T09:00:00.000Z",
      content: { type: "text", text: "Здравствуйте!" },
      ...overrides,
    },
  };
}

describe("Внутренний messaging-путь (issue #189, п. 1–3)", () => {
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

  it("принимает входящее сообщение и идемпотентно защищает от дублей", async () => {
    const first = await request(app.getHttpServer())
      .post("/internal/ingress/messages")
      .send(ingressEnvelope())
      .expect(202);

    expect(first.body).toMatchObject({
      accepted: true,
      duplicate: false,
      message_id: INGRESS_MESSAGE,
      organization_id: ORG,
      status: "routed",
      routed_to: "manager",
    });
    expect(first.body.client_id).toEqual(expect.any(String));
    expect(first.body.conversation_id).toEqual(expect.any(String));
    expect(first.body.endpoint_id).toEqual(expect.any(String));

    // Повторная доставка того же message_id — идемпотентна.
    const second = await request(app.getHttpServer())
      .post("/internal/ingress/messages")
      .send(ingressEnvelope())
      .expect(202);
    expect(second.body).toMatchObject({ duplicate: true, message_id: INGRESS_MESSAGE });

    await withClient(databaseUrl, async (client) => {
      await setPlatformOperator(client);
      const stored = await client.query(
        "SELECT direction, status, sender_type, channel FROM messages WHERE id = $1",
        [INGRESS_MESSAGE],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        direction: "inbound",
        status: "routed",
        sender_type: "client",
        channel: "telegram",
      });
      const audit = await client.query(
        "SELECT action FROM audit_events WHERE object_id = $1 AND action = 'message.ingress'",
        [INGRESS_MESSAGE],
      );
      expect(audit.rowCount).toBe(1);
    });
  });

  it("отклоняет некорректный конверт (несовпадение idempotency_key)", async () => {
    await request(app.getHttpServer())
      .post("/internal/ingress/messages")
      .send({
        ...ingressEnvelope(),
        idempotency_key: "20000000-0000-4000-8000-0000000006ff",
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("VALIDATION_FAILED");
      });
  });

  it("передаёт исходящее сообщение (routed→sent) и фиксирует попытку доставки", async () => {
    const egress = await request(app.getHttpServer())
      .post("/internal/egress/messages")
      .send({ organization_id: ORG, message_id: OUT_MESSAGE, adapter: "telegram" })
      .expect(202);

    expect(egress.body).toMatchObject({
      accepted: true,
      message_id: OUT_MESSAGE,
      status: "sent",
      adapter: "telegram",
      attempt_no: 1,
      forwarded: false,
    });
    expect(egress.body.delivery).toMatchObject({
      contract: "C2.EgressDelivery",
      version: "1.0.0",
      message: { direction: "outbound", message_id: OUT_MESSAGE },
    });

    await withClient(databaseUrl, async (client) => {
      await setPlatformOperator(client);
      const message = await client.query("SELECT status FROM messages WHERE id = $1", [OUT_MESSAGE]);
      expect(message.rows[0].status).toBe("sent");
      const attempt = await client.query(
        "SELECT status, attempt_no FROM message_delivery_attempts WHERE message_id = $1 AND adapter = 'telegram'",
        [OUT_MESSAGE],
      );
      expect(attempt.rows).toEqual([{ status: "sent", attempt_no: 1 }]);
    });

    // Обратная нога доставки: integration-platform подтверждает delivered.
    const delivery = await request(app.getHttpServer())
      .post("/internal/delivery/attempts")
      .send({
        contract: "C2.DeliveryAttempt",
        organization_id: ORG,
        message_id: OUT_MESSAGE,
        adapter: "telegram",
        attempt_no: 2,
        status: "delivered",
        occurred_at: "2026-07-04T09:05:00.000Z",
      })
      .expect(202);
    expect(delivery.body).toMatchObject({ message_status: "delivered", attempt_status: "delivered" });

    await withClient(databaseUrl, async (client) => {
      await setPlatformOperator(client);
      const message = await client.query(
        "SELECT status, delivered_at FROM messages WHERE id = $1",
        [OUT_MESSAGE],
      );
      expect(message.rows[0].status).toBe("delivered");
      expect(message.rows[0].delivered_at).toBeInstanceOf(Date);
    });
  });

  it("возвращает 404 при попытке egress для входящего сообщения", async () => {
    await request(app.getHttpServer())
      .post("/internal/egress/messages")
      .send({ organization_id: ORG, message_id: INGRESS_MESSAGE, adapter: "telegram" })
      .expect(404)
      .expect(({ body }) => {
        expect(body.code).toBe("MESSAGE_NOT_OUTBOUND");
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

async function setPlatformOperator(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
}

async function seedFixtures(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await setPlatformOperator(client);
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Tenant egress', 'issue #189 fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG],
    );
    await client.query(
      "INSERT INTO clients (id, organization_id, display_name) VALUES ($1, $2, 'Egress Client')",
      [OUT_CLIENT, ORG],
    );
    await client.query(
      `
        INSERT INTO communication_endpoints (
          id, organization_id, client_id, channel, external_id, verified, verified_at, metadata
        )
        VALUES ($1, $2, $3, 'telegram', 'tg-bot-1:tg-user-9', true, '2026-01-01T00:00:00.000Z',
          '{"channel_id":"777","conversation_ref":"chat-9"}'::jsonb)
      `,
      [OUT_ENDPOINT, ORG, OUT_CLIENT],
    );
    await client.query(
      `
        INSERT INTO conversations (id, organization_id, client_id, status, last_message_at, created_at, updated_at)
        VALUES ($1, $2, $3, 'open', '2026-07-04T08:00:00.000Z', '2026-07-04T08:00:00.000Z', '2026-07-04T08:00:00.000Z')
      `,
      [OUT_CONVERSATION, ORG, OUT_CLIENT],
    );
    await client.query(
      `
        INSERT INTO messages (
          id, organization_id, conversation_id, endpoint_id, channel, direction, sender_type,
          sequence_number, type, content, status, created_at
        )
        VALUES ($1, $2, $3, $4, 'telegram', 'outbound', 'manager', 1, 'text',
          '{"text":"Ответ оператора"}'::jsonb, 'routed', '2026-07-04T08:30:00.000Z')
      `,
      [OUT_MESSAGE, ORG, OUT_CONVERSATION, OUT_ENDPOINT],
    );
  });
}
