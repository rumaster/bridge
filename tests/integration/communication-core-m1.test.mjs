import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import { DEMO_ORGANIZATION_SEED } from "../../packages/testing/src/db/m0-seed-data.mjs";
import {
  createCommunicationCoreM1Service,
  createPostgresCommunicationCoreStore,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_core_m1",
  user: "bridge_core_m1",
  password: "bridge_core_m1",
};
const ORG_A = DEMO_ORGANIZATION_SEED.id;
const ORG_B = "10000000-0000-4000-8000-000000000102";
const INBOUND_A = "10000000-0000-4000-8000-000000000621";
const INBOUND_B = "10000000-0000-4000-8000-000000000622";
const OUTBOUND_A = "10000000-0000-4000-8000-000000000623";

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

async function insertOrganization(client, id, name) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', true)");
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, $2, 'M1 Communication Core integration fixture', 'UTC', 'ru-RU', 'active')
      `,
      [id, name],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function createCore(client) {
  const deliveries = [];
  const core = createCommunicationCoreM1Service({
    store: createPostgresCommunicationCoreStore({ client }),
    clock: () => "2026-07-03T10:10:00.000Z",
    egressAdapter: {
      async deliver(delivery) {
        deliveries.push(delivery);
        return { accepted: true, duplicate: false, status: "sent" };
      },
    },
  });

  return { core, deliveries };
}

function ingress(messageId, organizationId, senderRef) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: "2026-07-03T10:09:59.000Z",
    message: {
      message_id: messageId,
      organization_id: organizationId,
      channel_id: "web-chat-channel",
      channel_type: "web_chat",
      external_message_id: `external-${senderRef}`,
      conversation_ref: `room-${senderRef}`,
      sender_ref: senderRef,
      direction: "inbound",
      content: { type: "text", text: `hello from ${senderRef}` },
      attachments: [
        {
          id: "10000000-0000-4000-8000-000000000721",
          kind: "file",
          storage_ref: `s3://bridge-test/${senderRef}.txt`,
          mime: "text/plain",
          size: 12,
        },
      ],
      occurred_at: "2026-07-03T10:09:59.000Z",
    },
  };
}

describe("Communication Core M1 PostgreSQL integration", () => {
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

    await withClient(config, async (client) => {
      await insertOrganization(client, ORG_A, "Core M1 Organization A");
      await insertOrganization(client, ORG_B, "Core M1 Organization B");
    });
  });

  after(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("сохраняет ingress, изолирует арендаторов и записывает egress delivery attempt", async () => {
    await withClient(config, async (client) => {
      const { core, deliveries } = createCore(client);

      const acceptedA = await core.acceptIngressMessage(ingress(INBOUND_A, ORG_A, "visitor-a"));
      const duplicateA = await core.acceptIngressMessage(ingress(INBOUND_A, ORG_A, "visitor-a"));
      const acceptedB = await core.acceptIngressMessage(ingress(INBOUND_B, ORG_B, "visitor-b"));

      assert.equal(acceptedA.status, "routed");
      assert.equal(duplicateA.duplicate, true);
      assert.equal(acceptedB.organization_id, ORG_B);

      const conversationsA = await core.listConversations({ organizationId: ORG_A });
      const conversationsB = await core.listConversations({ organizationId: ORG_B });
      assert.equal(conversationsA.data.length, 1);
      assert.equal(conversationsB.data.length, 1);
      assert.notEqual(conversationsA.data[0].id, conversationsB.data[0].id);

      const messagesA = await core.listConversationMessages({
        organizationId: ORG_A,
        conversationId: acceptedA.conversation_id,
      });
      assert.equal(messagesA.data.length, 1);
      assert.equal(messagesA.data[0].attachments.length, 1);
      assert.equal(messagesA.data[0].attachments[0].storage_ref, "s3://bridge-test/visitor-a.txt");

      const outbound = await core.sendManagerMessage({
        idempotency_key: OUTBOUND_A,
        organization_id: ORG_A,
        conversation_id: acceptedA.conversation_id,
        sender_type: "manager",
        type: "text",
        content: { text: "manager reply" },
      });

      assert.equal(outbound.status, "sent");
      assert.equal(outbound.delivery_attempt.status, "sent");
      assert.equal(deliveries.length, 1);

      const attempts = await client.query(
        `
          SELECT attempt_no, status
          FROM message_delivery_attempts
          WHERE message_id = $1
        `,
        [OUTBOUND_A],
      );
      assert.deepEqual(attempts.rows, [{ attempt_no: 1, status: "sent" }]);
    });
  });
});
