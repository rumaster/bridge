import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import { createDeterministicFbpMock } from "../../services/fbp-engine/src/deterministic-fbp.mjs";
import {
  createCommunicationCoreM1Service,
  createFbpWorkflowOutboxPublisher,
  createPostgresCommunicationCoreStore,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_core_m3",
  user: "bridge_core_m3",
  password: "bridge_core_m3",
};
const ORG_A = "10000000-0000-4000-8000-000000000181";
const MSG_1 = "10000000-0000-4000-8000-000000000891";
const MSG_FAIL = "10000000-0000-4000-8000-000000000892";

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
        VALUES ($1, 'Core M3 Organization', 'M3 Communication Core fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG_A],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function createCore(client) {
  return createCommunicationCoreM1Service({
    store: createPostgresCommunicationCoreStore({ client }),
    clock: () => "2026-07-03T12:00:00.000Z",
  });
}

function ingress({
  messageId = MSG_1,
  occurredAt = "2026-07-03T11:59:00.000Z",
  senderRef = "visitor-m3",
} = {}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: occurredAt,
    message: {
      message_id: messageId,
      organization_id: ORG_A,
      channel_id: "web-chat-channel",
      channel_type: "web_chat",
      external_message_id: `external-${messageId}`,
      conversation_ref: "web-chat-room-m3",
      sender_ref: senderRef,
      direction: "inbound",
      content: {
        type: "text",
        text: `workflow event ${messageId}`,
      },
      occurred_at: occurredAt,
    },
  };
}

function failOnOutboxInsert(client) {
  return {
    async query(sql, params) {
      if (typeof sql === "string" && sql.includes("INSERT INTO outbox_events")) {
        throw new Error("forced outbox insert failure");
      }

      return client.query(sql, params);
    },
  };
}

describe("Communication Core M3 PostgreSQL outbox integration", () => {
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

  it("пишет доменные события в outbox, откатывает message+outbox атомарно и доставляет их в FBP-мок без дублей", async () => {
    await withClient(config, async (client) => {
      const core = createCore(client);
      const accepted = await core.acceptIngressMessage(ingress());

      let outbox = await client.query(
        `
          SELECT aggregate_type, aggregate_id, event_type, payload, status
          FROM outbox_events
          WHERE organization_id = $1
          ORDER BY created_at ASC, event_type ASC
        `,
        [ORG_A],
      );
      assert.deepEqual(
        outbox.rows.map((row) => row.event_type),
        ["conversation.created", "message.created", "message.status_changed"],
      );
      assert.deepEqual(
        outbox.rows.map((row) => row.status),
        ["pending", "pending", "pending"],
      );
      assert.equal(outbox.rows[0].aggregate_id, accepted.conversation_id);
      assert.equal(outbox.rows[1].aggregate_id, MSG_1);
      assert.equal(outbox.rows[1].payload.status, "received");
      assert.equal(outbox.rows[2].payload.previous_status, "received");
      assert.equal(outbox.rows[2].payload.status, "routed");

      await core.acceptIngressMessage(ingress());
      outbox = await client.query(
        "SELECT count(*)::int AS count FROM outbox_events WHERE organization_id = $1",
        [ORG_A],
      );
      assert.equal(outbox.rows[0].count, 3);

      const failingCore = createCore(failOnOutboxInsert(client));
      await assert.rejects(
        () =>
          failingCore.acceptIngressMessage(
            ingress({
              messageId: MSG_FAIL,
              senderRef: "visitor-m3-fail",
            }),
          ),
        /forced outbox insert failure/,
      );
      const rolledBackMessage = await client.query(
        "SELECT count(*)::int AS count FROM messages WHERE organization_id = $1 AND id = $2",
        [ORG_A, MSG_FAIL],
      );
      const rolledBackOutbox = await client.query(
        "SELECT count(*)::int AS count FROM outbox_events WHERE organization_id = $1 AND aggregate_id = $2",
        [ORG_A, MSG_FAIL],
      );
      assert.equal(rolledBackMessage.rows[0].count, 0);
      assert.equal(rolledBackOutbox.rows[0].count, 0);

      const fbp = createDeterministicFbpMock({
        now: () => "2026-07-03T12:01:00.000Z",
      });
      const publisher = createFbpWorkflowOutboxPublisher({
        fbp,
        workflowId: "workflow-core-domain-events",
        workflowVersionId: "workflow-version-core-domain-events",
        actorUserId: "system",
      });

      const firstReplay = await core.publishOutboxEvents({
        organizationId: ORG_A,
        publisher,
      });
      const secondReplay = await core.publishOutboxEvents({
        organizationId: ORG_A,
        publisher,
      });

      assert.equal(firstReplay.published_count, 3);
      assert.equal(firstReplay.failed_count, 0);
      assert.equal(secondReplay.published_count, 0);
      assert.equal(fbp.getMetrics().workflow_start_total, 3);

      const statuses = await client.query(
        `
          SELECT status, published_at IS NOT NULL AS has_published_at
          FROM outbox_events
          WHERE organization_id = $1
          ORDER BY created_at ASC, event_type ASC
        `,
        [ORG_A],
      );
      assert.deepEqual(
        statuses.rows.map((row) => row.status),
        ["published", "published", "published"],
      );
      assert.deepEqual(
        statuses.rows.map((row) => row.has_published_at),
        [true, true, true],
      );
    });
  });
});
