import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import {
  createBroadcastCoreDeliveryDraft,
} from "../../packages/contracts/src/c8.mjs";
import { createEdgeTunnelMessage } from "../../packages/contracts/src/c9.mjs";
import {
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
  createPostgresCommunicationCoreStore,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_core_m4",
  user: "bridge_core_m4",
  password: "bridge_core_m4",
};

const ORG = "10000000-0000-4000-8000-000000000401";
const ENDPOINT_EXTERNAL = "10000000-0000-4000-8000-0000000004e1";
const CONVERSATION_REF = "20000000-0000-4000-8000-0000000004c1";

const EDGE_IDS = {
  1: "30000000-0000-4000-8000-000000000401",
  2: "30000000-0000-4000-8000-000000000402",
  3: "30000000-0000-4000-8000-000000000403",
};

function connectionConfig(container) {
  return {
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    ...TEST_DB,
  };
}

function databaseUrl(config) {
  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`;
}

async function withClient(config, callback) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function insertOrganization(client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', true)");
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Core M4 Organization', 'M4 CP-6/CP-7 fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function createClock() {
  let tick = 0;
  return () => `2026-07-04T09:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function createCore(client) {
  return createCommunicationCoreM1Service({
    store: createPostgresCommunicationCoreStore({ client }),
    clock: createClock(),
  });
}

function canonicalMessage({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORG,
    conversation_id: CONVERSATION_REF,
    endpoint_id: ENDPOINT_EXTERNAL,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `edge ${seq}` },
    status: "received",
    created_at: "2026-07-04T08:00:00.000Z",
    updated_at: "2026-07-04T08:00:00.000Z",
    metadata: {},
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonicalMessage({ id, seq }),
    receivedAt: "2026-07-04T08:00:00.000Z",
  });
}

describe("Communication Core M4 PostgreSQL — CP-6/CP-7 интеграция", () => {
  let container;
  let config;

  before(async () => {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withExposedPorts(POSTGRES_PORT)
      .withEnvironment({
        POSTGRES_DB: TEST_DB.database,
        POSTGRES_USER: TEST_DB.user,
        POSTGRES_PASSWORD: TEST_DB.password,
      })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    config = connectionConfig(container);
    await runMigrations({ databaseUrl: databaseUrl(config), direction: "up" });
    await withClient(config, insertOrganization);
  });

  after(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("CP-7: восстанавливает порядок из буфера SVC-EDGE и дедуплицирует в PostgreSQL", async () => {
    await withClient(config, async (client) => {
      const core = createCore(client);
      const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

      // Буфер отдал сообщения не по порядку (3, 1, 2) с повтором seq 1.
      const batch = [
        tunnelMessage({ id: EDGE_IDS[3], seq: 3 }),
        tunnelMessage({ id: EDGE_IDS[1], seq: 1 }),
        tunnelMessage({ id: EDGE_IDS[2], seq: 2 }),
        tunnelMessage({ id: EDGE_IDS[1], seq: 1 }),
      ];

      const first = await intake.intakeBatch(batch);
      assert.equal(first.forwarded, 3, "три уникальных сообщения приняты ядром");
      assert.equal(first.duplicates, 1, "повтор в батче отброшен");
      assert.equal(first.reordered, true, "порядок восстановлен");

      const stored = await client.query(
        `
          SELECT id, sequence_number
          FROM messages
          WHERE organization_id = $1 AND direction = 'inbound'
          ORDER BY sequence_number ASC
        `,
        [ORG],
      );
      assert.deepEqual(
        stored.rows.map((row) => Number(row.sequence_number)),
        [1, 2, 3],
        "сообщения сохранены по возрастанию sequence_number",
      );
      assert.deepEqual(
        stored.rows.map((row) => row.id),
        [EDGE_IDS[1], EDGE_IDS[2], EDGE_IDS[3]],
        "идентификаторы соответствуют порядку sequence_number",
      );

      // Повторный дренаж того же буфера — идемпотентность на уровне БД.
      const second = await intake.intakeBatch(batch);
      assert.equal(second.forwarded, 0, "повторный дренаж ничего не добавляет");
      assert.equal(second.duplicates, 4, "все сообщения распознаны как дубли");

      const count = await client.query(
        `SELECT count(*)::int AS count FROM messages WHERE organization_id = $1 AND direction = 'inbound'`,
        [ORG],
      );
      assert.equal(count.rows[0].count, 3, "в БД по-прежнему три сообщения");
    });
  });

  it("CP-6: доставляет кампанию через ядро со связью broadcast_messages и журналом попыток", async () => {
    await withClient(config, async (client) => {
      const core = createCore(client);

      // Сначала входящее сообщение создаёт endpoint и conversation.
      // Отдельный endpoint/conversation, чтобы sequence_number не пересекался
      // с CP-7 (тесты используют общую БД контейнера).
      const inbound = await core.acceptIngressMessage({
        ...canonicalMessage({ id: "40000000-0000-4000-8000-000000000401", seq: 1 }),
        endpoint_id: "10000000-0000-4000-8000-0000000004e2",
        conversation_id: "20000000-0000-4000-8000-0000000004c2",
      });

      const store = createPostgresCommunicationCoreStore({ client });
      let calls = 0;
      const flakyAdapter = {
        async deliver() {
          calls += 1;
          if (calls === 1) return { accepted: false, error: "temporary" };
          return { accepted: true, status: "sent" };
        },
      };
      const coordinator = createBroadcastDeliveryCoordinator({
        store,
        egressAdapter: flakyAdapter,
        clock: createClock(),
        maxAttempts: 3,
      });

      const broadcastId = "50000000-0000-4000-8000-000000000401";
      const messageId = "60000000-0000-4000-8000-000000000401";
      const draft = createBroadcastCoreDeliveryDraft({
        broadcastId,
        organizationId: ORG,
        messageId,
        conversationId: inbound.conversation_id,
        endpointId: inbound.endpoint_id,
        channel: "web_chat",
        text: "Кампания через ядро",
        createdAt: "2026-07-04T09:05:00.000Z",
      });

      const result = await coordinator.deliver(draft);
      assert.equal(result.duplicate, false);
      assert.equal(result.delivered, true);
      assert.equal(result.status, "sent");
      assert.equal(result.broadcast_message_status, "sent");
      assert.equal(result.attempts.length, 2, "провальная и успешная попытки");

      // Сообщение прошло через ядро как outbound/broadcast.
      const message = await client.query(
        `SELECT direction, sender_type, status FROM messages WHERE organization_id = $1 AND id = $2`,
        [ORG, messageId],
      );
      assert.equal(message.rows.length, 1);
      assert.equal(message.rows[0].direction, "outbound");
      assert.equal(message.rows[0].sender_type, "broadcast");
      assert.equal(message.rows[0].status, "sent");

      // Связь broadcast_messages <-> messages.
      const link = await client.query(
        `SELECT status FROM broadcast_messages WHERE organization_id = $1 AND broadcast_id = $2 AND message_id = $3`,
        [ORG, broadcastId, messageId],
      );
      assert.equal(link.rows.length, 1);
      assert.equal(link.rows[0].status, "sent");

      // Полный журнал попыток доставки.
      const attempts = await client.query(
        `SELECT attempt_no, status FROM message_delivery_attempts WHERE organization_id = $1 AND message_id = $2 ORDER BY attempt_no ASC`,
        [ORG, messageId],
      );
      assert.deepEqual(
        attempts.rows.map((row) => row.status),
        ["failed", "sent"],
      );

      // Дедуп-окно: повторный черновик не вызывает адаптер и не создаёт дублей.
      const callsBefore = calls;
      const duplicate = await coordinator.deliver(draft);
      assert.equal(duplicate.duplicate, true);
      assert.equal(calls, callsBefore, "адаптер не вызван повторно");

      const messageCount = await client.query(
        `SELECT count(*)::int AS count FROM messages WHERE organization_id = $1 AND id = $2`,
        [ORG, messageId],
      );
      assert.equal(messageCount.rows[0].count, 1);
    });
  });
});
