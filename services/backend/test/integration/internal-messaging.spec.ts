import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

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
const FAIL_MESSAGE = "20000000-0000-4000-8000-000000000603";
const EDGE_CLIENT = "20000000-0000-4000-8000-000000000302";
const EDGE_ENDPOINT = "20000000-0000-4000-8000-000000000402";
const EDGE_CONVERSATION = "20000000-0000-4000-8000-000000000502";
const EDGE_MESSAGE = "20000000-0000-4000-8000-000000000604";
const BROADCAST_ID = "20000000-0000-4000-8000-000000000701";
const BROADCAST_MESSAGE = "20000000-0000-4000-8000-000000000605";

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

function edgeTunnelMessage(): Record<string, unknown> {
  return {
    contract: "C9.EdgeTunnelMessage",
    version: "1.0.0",
    endpoint_id: EDGE_ENDPOINT,
    sequence_number: 7,
    idempotency_key: EDGE_MESSAGE,
    payload: {
      id: EDGE_MESSAGE,
      idempotency_key: EDGE_MESSAGE,
      organization_id: ORG,
      conversation_id: EDGE_CONVERSATION,
      client_id: EDGE_CLIENT,
      endpoint_id: EDGE_ENDPOINT,
      channel: "telegram",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 7,
      type: "text",
      content: { text: "Сообщение через edge tunnel" },
      status: "received",
      created_at: "2026-07-04T09:10:00.000Z",
      metadata: {
        channel_id: "tg-bot-edge",
        conversation_ref: "edge-chat-1",
        external_id: "tg-bot-edge:edge-user-1",
        sender_ref: "edge-user-1",
      },
    },
  };
}

function broadcastDeliveryDraft(): Record<string, unknown> {
  return {
    contract: "C8.BroadcastCoreDeliveryDraft",
    version: "1.0.0",
    broadcast_id: BROADCAST_ID,
    organization_id: ORG,
    delivery_path: "C1/C2",
    core_contracts: ["C1", "C2"],
    sender_type: "broadcast",
    broadcast_name: "Июльская рассылка",
    message: {
      id: BROADCAST_MESSAGE,
      idempotency_key: BROADCAST_MESSAGE,
      organization_id: ORG,
      conversation_id: OUT_CONVERSATION,
      endpoint_id: OUT_ENDPOINT,
      channel: "telegram",
      direction: "outbound",
      sender_type: "broadcast",
      sequence_number: 2,
      type: "text",
      content: { text: "Новости июля" },
      status: "routed",
      created_at: "2026-07-04T09:20:00.000Z",
    },
  };
}

describe("Внутренний messaging-путь (issue #189/#191)", () => {
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
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 1))
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

  it("принимает C9 edge tunnel message и сохраняет канонический C1 ingress", async () => {
    const first = await request(app.getHttpServer())
      .post("/internal/edge/tunnel/messages")
      .send(edgeTunnelMessage())
      .expect(202);

    expect(first.body).toMatchObject({
      contract: "C9.EdgeTunnelAck",
      version: "1.0.0",
      accepted: true,
      duplicate: false,
      message_id: EDGE_MESSAGE,
      endpoint_id: EDGE_ENDPOINT,
      sequence_number: 7,
      idempotency_key: EDGE_MESSAGE,
      core_status: "routed",
    });

    const second = await request(app.getHttpServer())
      .post("/internal/edge/tunnel/messages")
      .send(edgeTunnelMessage())
      .expect(202);
    expect(second.body).toMatchObject({ duplicate: true, message_id: EDGE_MESSAGE });

    await withClient(databaseUrl, async (client) => {
      await setPlatformOperator(client);
      const stored = await client.query(
        `
          SELECT conversation_id, endpoint_id, direction, sender_type, sequence_number, status
          FROM messages
          WHERE organization_id = $1 AND id = $2
        `,
        [ORG, EDGE_MESSAGE],
      );
      expect(stored.rows).toEqual([
        {
          conversation_id: EDGE_CONVERSATION,
          endpoint_id: EDGE_ENDPOINT,
          direction: "inbound",
          sender_type: "client",
          sequence_number: "7",
          status: "routed",
        },
      ]);
    });
  });

  it("доставляет C8 broadcast draft через C1/C2, связывает broadcast_messages и журналирует попытку", async () => {
    const response = await request(app.getHttpServer())
      .post("/internal/broadcast/deliveries")
      .send(broadcastDeliveryDraft())
      .expect(202);

    expect(response.body).toMatchObject({
      duplicate: false,
      delivered: true,
      degraded: false,
      broadcast_id: BROADCAST_ID,
      message_id: BROADCAST_MESSAGE,
      conversation_id: OUT_CONVERSATION,
      endpoint_id: OUT_ENDPOINT,
      sequence_number: 3,
      status: "sent",
      broadcast_message_status: "sent",
      forwarded: false,
      attempts: [{ attempt_no: 1, status: "sent", error: null }],
    });

    await withClient(databaseUrl, async (client) => {
      await setPlatformOperator(client);
      const message = await client.query(
        "SELECT direction, sender_type, status FROM messages WHERE id = $1",
        [BROADCAST_MESSAGE],
      );
      expect(message.rows[0]).toMatchObject({
        direction: "outbound",
        sender_type: "broadcast",
        status: "sent",
      });
      const link = await client.query(
        "SELECT status FROM broadcast_messages WHERE organization_id = $1 AND broadcast_id = $2 AND message_id = $3",
        [ORG, BROADCAST_ID, BROADCAST_MESSAGE],
      );
      expect(link.rows).toEqual([{ status: "sent" }]);
      const attempts = await client.query(
        "SELECT attempt_no, status FROM message_delivery_attempts WHERE message_id = $1 AND adapter = 'broadcast'",
        [BROADCAST_MESSAGE],
      );
      expect(attempts.rows).toEqual([{ attempt_no: 1, status: "sent" }]);
    });
  });

  it("помечает egress как degraded после повторных отказов adapter-path", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end("adapter unavailable");
    });
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    const previousUrl = process.env.INTEGRATION_EGRESS_URL;
    process.env.INTEGRATION_EGRESS_URL = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/egress`;

    try {
      const response = await request(app.getHttpServer())
        .post("/internal/egress/messages")
        .send({
          organization_id: ORG,
          message_id: FAIL_MESSAGE,
          adapter: "telegram",
          max_attempts: 2,
          timeout_ms: 500,
        })
        .expect(202);

      expect(response.body).toMatchObject({
        accepted: false,
        message_id: FAIL_MESSAGE,
        status: "failed",
        adapter: "telegram",
        attempt_no: 2,
        forwarded: false,
        degraded: true,
      });
      expect(response.body.error).toContain("HTTP 503");

      await withClient(databaseUrl, async (client) => {
        await setPlatformOperator(client);
        const message = await client.query("SELECT status FROM messages WHERE id = $1", [
          FAIL_MESSAGE,
        ]);
        expect(message.rows[0].status).toBe("failed");
        const attempts = await client.query(
          "SELECT attempt_no, status, error FROM message_delivery_attempts WHERE message_id = $1 AND adapter = 'telegram' ORDER BY attempt_no",
          [FAIL_MESSAGE],
        );
        expect(attempts.rows).toEqual([
          { attempt_no: 1, status: "failed", error: expect.stringContaining("HTTP 503") },
          { attempt_no: 2, status: "failed", error: expect.stringContaining("HTTP 503") },
        ]);
      });
    } finally {
      if (previousUrl === undefined) {
        delete process.env.INTEGRATION_EGRESS_URL;
      } else {
        process.env.INTEGRATION_EGRESS_URL = previousUrl;
      }
      await new Promise<void>((resolveServer, reject) => {
        server.close((error) => (error ? reject(error) : resolveServer()));
      });
    }
  });

  it("экспортирует load-probe ingress counters в /metrics", async () => {
    const response = await request(app.getHttpServer()).get("/metrics").expect(200);

    expect(response.text).toContain(
      'bridge_backend_communication_core_ingress_total{result="all"}',
    );
    expect(response.text).toContain(
      'bridge_backend_communication_core_ingress_total{result="duplicate"}',
    );
    expect(response.text).toContain(
      'bridge_backend_communication_core_ingress_latency_ms{quantile="p95"}',
    );
  });
});

function connectionString(container: StartedTestContainer): string {
  return `postgres://${DB.user}:${DB.password}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB.database}`;
}

function runRootScript(scriptPath: string, args: string[], databaseUrl: string): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      execFileSync("node", [scriptPath, ...args], {
        cwd: resolve(__dirname, "../../../.."),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      });
      return;
    } catch (error) {
      lastError = error;
      sleep(500);
    }
  }

  throw lastError;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
    await client.query(
      `
        INSERT INTO messages (
          id, organization_id, conversation_id, endpoint_id, channel, direction, sender_type,
          sequence_number, type, content, status, created_at
        )
        VALUES ($1, $2, $3, $4, 'telegram', 'outbound', 'manager', 2, 'text',
          '{"text":"Ответ с ошибкой адаптера"}'::jsonb, 'routed', '2026-07-04T08:35:00.000Z')
      `,
      [FAIL_MESSAGE, ORG, OUT_CONVERSATION, OUT_ENDPOINT],
    );
  });
}
