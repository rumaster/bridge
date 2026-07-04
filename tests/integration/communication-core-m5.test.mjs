import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import {
  createAdapterFailureCoordinator,
  createAiDegradationGuard,
  createCommunicationCoreM1Service,
  createPostgresCommunicationCoreStore,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_core_m5",
  user: "bridge_core_m5",
  password: "bridge_core_m5",
};

const ORG = "10000000-0000-4000-8000-000000000501";
const DUPLICATE_MESSAGE_ID = "30000000-0000-4000-8000-0000000005d1";

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

async function connectClient(config) {
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

async function insertOrganization(client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', true)");
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Core M5 Organization', 'M5 load/degradation fixture', 'UTC', 'ru-RU', 'active')
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
  return () => `2026-07-04T10:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function createCore(client) {
  return createCommunicationCoreM1Service({
    store: createPostgresCommunicationCoreStore({ client }),
    clock: createClock(),
  });
}

function ingressEnvelope({
  messageId,
  text = "M5 message",
  channelId = "web-chat-m5",
  channelType = "web_chat",
  senderRef = "visitor-m5",
  conversationRef = "web-chat-m5-room",
}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: "2026-07-04T09:59:00.000Z",
    message: {
      message_id: messageId,
      organization_id: ORG,
      channel_id: channelId,
      channel_type: channelType,
      external_message_id: messageId,
      conversation_ref: conversationRef,
      sender_ref: senderRef,
      direction: "inbound",
      content: {
        type: "text",
        text,
      },
      occurred_at: "2026-07-04T09:59:00.000Z",
    },
  };
}

function createFirstLookupBarrier({ messageId, participants }) {
  let waiting = 0;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });

  return async function waitAtFirstMessageLookup() {
    waiting += 1;
    if (waiting === participants) {
      release();
    }
    await released;
  };
}

function wrapClientFirstMessageLookup(client, { messageId, waitAtBarrier }) {
  let waited = false;

  return {
    async query(sql, params) {
      if (
        !waited &&
        typeof sql === "string" &&
        sql.includes("FROM messages") &&
        sql.includes("AND id = $2") &&
        params?.[1] === messageId
      ) {
        waited = true;
        await waitAtBarrier();
      }

      return client.query(sql, params);
    },
  };
}

describe("Communication Core M5 PostgreSQL — масштабирование нескольких экземпляров", () => {
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

  it("дедуплицирует конкурентный idempotency_key между двумя экземплярами ядра", async () => {
    const clientA = await connectClient(config);
    const clientB = await connectClient(config);

    try {
      const waitAtBarrier = createFirstLookupBarrier({
        messageId: DUPLICATE_MESSAGE_ID,
        participants: 2,
      });
      const coreA = createCore(
        wrapClientFirstMessageLookup(clientA, {
          messageId: DUPLICATE_MESSAGE_ID,
          waitAtBarrier,
        }),
      );
      const coreB = createCore(
        wrapClientFirstMessageLookup(clientB, {
          messageId: DUPLICATE_MESSAGE_ID,
          waitAtBarrier,
        }),
      );

      const results = await Promise.allSettled([
        coreA.acceptIngressMessage(ingressEnvelope({
          messageId: DUPLICATE_MESSAGE_ID,
          text: "race from instance A",
        })),
        coreB.acceptIngressMessage(ingressEnvelope({
          messageId: DUPLICATE_MESSAGE_ID,
          text: "race from instance B",
        })),
      ]);

      assert.deepEqual(
        results.map((result) => result.status),
        ["fulfilled", "fulfilled"],
        "оба экземпляра должны завершиться без ошибки unique constraint",
      );
      assert.equal(
        results.filter((result) => result.value.duplicate).length,
        1,
        "один вызов сохраняет сообщение, второй возвращается как duplicate",
      );

      await withClient(config, async (client) => {
        const stored = await client.query(
          `
            SELECT count(*)::int AS count
            FROM messages
            WHERE organization_id = $1 AND id = $2
          `,
          [ORG, DUPLICATE_MESSAGE_ID],
        );
        assert.equal(stored.rows[0].count, 1, "в общей БД нет дублей");
      });
    } finally {
      await clientB.end();
      await clientA.end();
    }
  });

  it("сохраняет монотонный sequence_number при конкурентном приёме одним endpoint", async () => {
    const clients = await Promise.all(
      Array.from({ length: 16 }, () => connectClient(config)),
    );

    try {
      const cores = clients.map(createCore);
      const messages = Array.from({ length: 16 }, (_item, index) =>
        ingressEnvelope({
          messageId: `30000000-0000-4000-8000-000000001${String(index).padStart(3, "0")}`,
          text: `scale ${index}`,
          senderRef: "visitor-m5-scale",
          conversationRef: "web-chat-m5-scale-room",
        }),
      );

      const results = await Promise.all(
        messages.map((message, index) =>
          cores[index % cores.length].acceptIngressMessage(message),
        ),
      );

      assert.equal(results.every((result) => result.status === "routed"), true);
      await withClient(config, async (client) => {
        const stored = await client.query(
          `
            SELECT id, sequence_number
            FROM messages
            WHERE organization_id = $1
              AND content ->> 'text' LIKE 'scale %'
            ORDER BY sequence_number ASC
          `,
          [ORG],
        );

        assert.equal(stored.rows.length, 16);
        assert.deepEqual(
          stored.rows.map((row) => Number(row.sequence_number)),
          Array.from({ length: 16 }, (_item, index) => index + 1),
        );
        assert.equal(
          new Set(stored.rows.map((row) => row.id)).size,
          16,
          "дубли сообщений не появились",
        );
      });
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("деградирует при недоступном адаптере/AI и продолжает обрабатывать другой канал", async () => {
    const clientA = await connectClient(config);
    const clientB = await connectClient(config);

    try {
      const coreA = createCore(clientA);
      const coreB = createCore(clientB);
      const stuck = await coreA.acceptIngressMessage(
        ingressEnvelope({
          messageId: "30000000-0000-4000-8000-0000000005a1",
          text: "adapter will time out",
          senderRef: "visitor-m5-adapter-timeout",
          conversationRef: "web-chat-m5-adapter-timeout",
        }),
      );
      const coordinator = createAdapterFailureCoordinator({
        store: createPostgresCommunicationCoreStore({ client: clientA }),
        adapterClient: {
          async deliver() {
            return new Promise(() => undefined);
          },
        },
        adapter: "web_chat",
        clock: createClock(),
        maxAttempts: 1,
        timeoutMs: 1,
      });
      const ai = createAiDegradationGuard({
        aiClient: {
          async suggest() {
            throw new Error("ai unavailable");
          },
        },
        clock: createClock(),
      });

      const adapterFailure = coordinator.deliver({
        organizationId: ORG,
        messageId: stuck.message_id,
        delivery: {
          contract: "C2.EgressDelivery",
          version: "1.0.0",
          idempotency_key: stuck.message_id,
        },
      });
      const aiFallback = await ai.suggest({
        organization_id: ORG,
        conversation_id: stuck.conversation_id,
        message_id: stuck.message_id,
      });
      const otherChannel = await coreB.acceptIngressMessage(
        ingressEnvelope({
          messageId: "30000000-0000-4000-8000-0000000005a2",
          text: "email continues",
          channelId: "email-m5",
          channelType: "email",
          senderRef: "m5@example.test",
          conversationRef: "email-m5-thread",
        }),
      );
      const degraded = await adapterFailure;

      assert.equal(aiFallback.degraded, true);
      assert.equal(aiFallback.reason, "error");
      assert.equal(otherChannel.status, "routed");
      assert.equal(degraded.reason, "timeout");
      assert.equal(degraded.status, "failed");

      await withClient(config, async (client) => {
        const statuses = await client.query(
          `
            SELECT id, status
            FROM messages
            WHERE organization_id = $1
              AND id = ANY($2::uuid[])
            ORDER BY id ASC
          `,
          [ORG, [stuck.message_id, otherChannel.message_id]],
        );
        assert.deepEqual(
          Object.fromEntries(statuses.rows.map((row) => [row.id, row.status])),
          {
            [stuck.message_id]: "failed",
            [otherChannel.message_id]: "routed",
          },
        );
      });
    } finally {
      await clientB.end();
      await clientA.end();
    }
  });
});
