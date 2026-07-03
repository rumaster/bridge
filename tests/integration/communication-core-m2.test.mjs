import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import {
  createCommunicationCoreM1Service,
  createInMemoryC7EventPublisher,
  createPostgresCommunicationCoreStore,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_core_m2",
  user: "bridge_core_m2",
  password: "bridge_core_m2",
};
const ORG_A = "10000000-0000-4000-8000-000000000171";
const MSG_1 = "10000000-0000-4000-8000-000000000781";
const MSG_2 = "10000000-0000-4000-8000-000000000782";
const MSG_3 = "10000000-0000-4000-8000-000000000783";

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
        VALUES ($1, 'Core M2 Organization', 'M2 Communication Core fixture', 'UTC', 'ru-RU', 'active')
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
  const realtimePublisher = createInMemoryC7EventPublisher({
    clock: () => "2026-07-03T12:00:00.000Z",
  });
  const core = createCommunicationCoreM1Service({
    store: createPostgresCommunicationCoreStore({ client }),
    realtimePublisher,
    clock: () => "2026-07-03T12:00:00.000Z",
  });

  return { core, realtimePublisher };
}

function ingress({
  channelId,
  channelType,
  conversationRef,
  messageId,
  occurredAt,
  senderRef,
  sequenceNumber,
}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: occurredAt,
    message: {
      message_id: messageId,
      organization_id: ORG_A,
      channel_id: channelId,
      channel_type: channelType,
      external_message_id: `external-${messageId}`,
      conversation_ref: conversationRef,
      sender_ref: senderRef,
      direction: "inbound",
      ...(sequenceNumber ? { sequence_number: sequenceNumber } : {}),
      identity: {
        link_type: "verified_email",
        value: "postgres-verified@example.bridge.local",
        verified: true,
      },
      content: {
        type: "text",
        text: `hello ${messageId}`,
      },
      occurred_at: occurredAt,
    },
  };
}

describe("Communication Core M2 PostgreSQL integration", () => {
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

  it("связывает verified endpoints, пишет links, обнаруживает gaps и выбирает канал по capabilities", async () => {
    await withClient(config, async (client) => {
      const { core, realtimePublisher } = createCore(client);

      const first = await core.acceptIngressMessage(
        ingress({
          channelId: "web-chat-channel",
          channelType: "web_chat",
          conversationRef: "web-chat-room",
          messageId: MSG_1,
          occurredAt: "2026-07-03T11:59:00.000Z",
          senderRef: "visitor-postgres",
        }),
      );
      const second = await core.acceptIngressMessage(
        ingress({
          channelId: "telegram-channel",
          channelType: "telegram",
          conversationRef: "telegram-chat",
          messageId: MSG_2,
          occurredAt: "2026-07-03T11:59:05.000Z",
          senderRef: "telegram-postgres",
        }),
      );
      const third = await core.acceptIngressMessage(
        ingress({
          channelId: "web-chat-channel",
          channelType: "web_chat",
          conversationRef: "web-chat-room",
          messageId: MSG_3,
          occurredAt: "2026-07-03T11:59:10.000Z",
          senderRef: "visitor-postgres",
          sequenceNumber: 3,
        }),
      );

      assert.equal(second.conversation_id, first.conversation_id);
      assert.deepEqual(third.sequence_gap, {
        endpoint_id: first.endpoint_id,
        expected_sequence_number: 2,
        received_sequence_number: 3,
      });

      const messages = await core.listConversationMessages({
        conversationId: first.conversation_id,
        limit: 10,
        organizationId: ORG_A,
      });
      assert.deepEqual(messages.data.map((message) => message.id), [MSG_1, MSG_2, MSG_3]);

      const links = await client.query(
        `
          SELECT link_type, evidence ->> 'identity_value' AS identity_value
          FROM client_identity_links
          WHERE organization_id = $1
            AND reverted_at IS NULL
          ORDER BY created_at ASC
        `,
        [ORG_A],
      );
      assert.deepEqual(links.rows, [
        {
          identity_value: "postgres-verified@example.bridge.local",
          link_type: "verified_email",
        },
        {
          identity_value: "postgres-verified@example.bridge.local",
          link_type: "verified_email",
        },
      ]);

      await seedChannels(client);
      const selected = await core.selectDeliveryChannel({
        organizationId: ORG_A,
        requiredCapabilities: ["voice"],
      });
      assert.equal(selected.channel_type, "email");

      assert.deepEqual(realtimePublisher.getEvents().map((event) => event.event), [
        "message.created",
        "message.status_changed",
        "message.created",
        "message.status_changed",
        "message.created",
        "message.status_changed",
      ]);
    });
  });
});

async function seedChannels(client) {
  await client.query(
    `
      INSERT INTO channels (id, organization_id, channel_type, name, status)
      VALUES
        ('10000000-0000-4000-8000-000000000871', $1, 'telegram', 'Telegram', 'connected'),
        ('10000000-0000-4000-8000-000000000872', $1, 'email', 'Email', 'connected')
    `,
    [ORG_A],
  );
  await client.query(
    `
      INSERT INTO adapter_capabilities (
        id,
        organization_id,
        channel_id,
        capability,
        supported
      )
      VALUES
        ('10000000-0000-4000-8000-000000000881', $1, '10000000-0000-4000-8000-000000000871', 'voice', false),
        ('10000000-0000-4000-8000-000000000882', $1, '10000000-0000-4000-8000-000000000872', 'voice', true)
    `,
    [ORG_A],
  );
}
