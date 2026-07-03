import assert from "node:assert/strict";
import { describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import { runSeeds } from "../../scripts/db-seed.mjs";
import {
  DEMO_ORGANIZATION_SEED,
  ROLE_SEEDS,
  SEEDED_ADMIN_USER_SEED,
} from "../../packages/testing/src/db/m0-seed-data.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_test",
  user: "bridge_test",
  password: "bridge_test",
};
const M1_TABLES = [
  "attachments",
  "audit_events",
  "auth_sessions",
  "client_notes",
  "client_tags",
  "clients",
  "communication_endpoints",
  "configuration_history",
  "configurations",
  "conversations",
  "invitations",
  "login_codes",
  "message_delivery_attempts",
  "messages",
  "organizations",
  "roles",
  "user_roles",
  "users",
];
const TENANT_RLS_TABLES = [
  "attachments",
  "audit_events",
  "auth_sessions",
  "client_notes",
  "client_tags",
  "clients",
  "communication_endpoints",
  "configuration_history",
  "configurations",
  "conversations",
  "invitations",
  "login_codes",
  "message_delivery_attempts",
  "messages",
  "organizations",
  "user_roles",
  "users",
];
const TENANT_ORGANIZATION_ID_TABLES = TENANT_RLS_TABLES.filter(
  (tableName) => tableName !== "organizations" && tableName !== "users",
);
const ORG_A = "10000000-0000-4000-8000-000000000101";
const ORG_B = "10000000-0000-4000-8000-000000000102";
const ROLE_MANAGER = "00000000-0000-4000-8000-000000000003";
const M1_FIXTURES = {
  [ORG_A]: {
    organization: ORG_A,
    user: "10000000-0000-4000-8000-000000000201",
    session: "10000000-0000-4000-8000-000000000211",
    loginCode: "10000000-0000-4000-8000-000000000221",
    invitation: "10000000-0000-4000-8000-000000000231",
    client: "10000000-0000-4000-8000-000000000301",
    clientNote: "10000000-0000-4000-8000-000000000311",
    clientTag: "10000000-0000-4000-8000-000000000321",
    endpoint: "10000000-0000-4000-8000-000000000401",
    conversation: "10000000-0000-4000-8000-000000000501",
    messageFirst: "10000000-0000-4000-8000-000000000601",
    messageSecond: "10000000-0000-4000-8000-000000000602",
    attachment: "10000000-0000-4000-8000-000000000701",
    attempt: "10000000-0000-4000-8000-000000000801",
    config: "10000000-0000-4000-8000-000000000901",
    audit: "10000000-0000-4000-8000-000000000a01",
  },
  [ORG_B]: {
    organization: ORG_B,
    user: "10000000-0000-4000-8000-000000000202",
    session: "10000000-0000-4000-8000-000000000212",
    loginCode: "10000000-0000-4000-8000-000000000222",
    invitation: "10000000-0000-4000-8000-000000000232",
    client: "10000000-0000-4000-8000-000000000302",
    clientNote: "10000000-0000-4000-8000-000000000312",
    clientTag: "10000000-0000-4000-8000-000000000322",
    endpoint: "10000000-0000-4000-8000-000000000402",
    conversation: "10000000-0000-4000-8000-000000000502",
    messageFirst: "10000000-0000-4000-8000-000000000603",
    messageSecond: "10000000-0000-4000-8000-000000000604",
    attachment: "10000000-0000-4000-8000-000000000702",
    attempt: "10000000-0000-4000-8000-000000000802",
    config: "10000000-0000-4000-8000-000000000902",
    audit: "10000000-0000-4000-8000-000000000a02",
  },
};

function connectionConfig(container, overrides = {}) {
  return {
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    ...TEST_DB,
    ...overrides,
  };
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

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError(`Unsafe SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

function expectedTenantRowCount(tableName, organizationId) {
  if (tableName === "messages") {
    return 2;
  }

  if (tableName === "configuration_history") {
    return organizationId === ORG_A ? 2 : 1;
  }

  return 1;
}

async function assertM1Schema(client, { expectSeedData }) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      ORDER BY table_name
    `,
    [M1_TABLES],
  );

  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    M1_TABLES,
  );

  const vectorExtension = await client.query(
    "SELECT extname FROM pg_extension WHERE extname = 'vector'",
  );
  assert.equal(vectorExtension.rowCount, 1);

  const vectorCast = await client.query("SELECT '[1,2,3]'::vector::text AS value");
  assert.equal(vectorCast.rows[0].value, "[1,2,3]");

  const rls = await client.query(
    `
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY($1)
      ORDER BY relname
    `,
    [TENANT_RLS_TABLES],
  );

  assert.deepEqual(
    rls.rows.map((row) => [
      row.relname,
      row.relrowsecurity,
      row.relforcerowsecurity,
    ]),
    TENANT_RLS_TABLES.map((tableName) => [tableName, true, true]),
  );

  const organizationColumns = await client.query(
    `
      SELECT table_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
        AND column_name = 'organization_id'
      ORDER BY table_name
    `,
    [TENANT_ORGANIZATION_ID_TABLES],
  );

  assert.deepEqual(
    organizationColumns.rows.map((row) => [row.table_name, row.is_nullable]),
    TENANT_ORGANIZATION_ID_TABLES.map((tableName) => [tableName, "NO"]),
  );

  const indexes = await client.query(
    `
      SELECT to_regclass('public.conversations_organization_client_idx') AS conversations_organization_client_idx,
             to_regclass('public.messages_endpoint_sequence_number_idx') AS messages_endpoint_sequence_number_idx
    `,
  );

  assert.equal(
    indexes.rows[0].conversations_organization_client_idx,
    "conversations_organization_client_idx",
  );
  assert.equal(
    indexes.rows[0].messages_endpoint_sequence_number_idx,
    "messages_endpoint_sequence_number_idx",
  );

  if (!expectSeedData) {
    return;
  }

  const roles = await client.query("SELECT code FROM roles ORDER BY code");
  assert.deepEqual(
    roles.rows.map((row) => row.code),
    ROLE_SEEDS.map((role) => role.code).sort(),
  );

  const organization = await client.query("SELECT id FROM organizations WHERE id = $1", [
    DEMO_ORGANIZATION_SEED.id,
  ]);
  assert.equal(organization.rowCount, 1);

  const seededAdmin = await client.query("SELECT organization_id FROM users WHERE id = $1", [
    SEEDED_ADMIN_USER_SEED.id,
  ]);
  assert.equal(seededAdmin.rowCount, 1);
  assert.equal(seededAdmin.rows[0].organization_id, DEMO_ORGANIZATION_SEED.id);
}

async function assertM1SchemaDropped(client) {
  const objectColumns = M1_TABLES.map(
    (tableName) => `to_regclass('public.${tableName}') AS ${tableName}`,
  ).join(",\n      ");
  const objects = await client.query(`
    SELECT
      ${objectColumns},
      to_regprocedure('app.current_organization_id()') AS current_organization_id,
      to_regprocedure('app.is_platform_operator()') AS is_platform_operator,
      to_regprocedure('app.reject_append_only_mutation()') AS reject_append_only_mutation,
      to_regprocedure('app.record_configuration_history()') AS record_configuration_history
  `);

  assert.deepEqual(objects.rows[0], {
    ...Object.fromEntries(M1_TABLES.map((tableName) => [tableName, null])),
    current_organization_id: null,
    is_platform_operator: null,
    reject_append_only_mutation: null,
    record_configuration_history: null,
  });

  const vectorExtension = await client.query(
    "SELECT extname FROM pg_extension WHERE extname = 'vector'",
  );
  assert.equal(vectorExtension.rowCount, 0);
}

async function assertRlsIsolation(adminConfig, adminClient) {
  const roleName = `rls_probe_${process.pid}`;
  const roleIdentifier = quoteIdentifier(roleName);

  await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  await adminClient.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD 'bridge_test'`);
  await adminClient.query(`GRANT USAGE ON SCHEMA app, public TO ${roleIdentifier}`);
  await adminClient.query(`GRANT SELECT ON ${M1_TABLES.map(quoteIdentifier).join(", ")} TO ${roleIdentifier}`);

  try {
    await withClient(connectionConfigFromAdmin(adminConfig, { user: roleName }), async (client) => {
      let result = await client.query("SELECT count(*)::int AS count FROM organizations");
      assert.equal(result.rows[0].count, 0);

      result = await client.query("SELECT count(*)::int AS count FROM users");
      assert.equal(result.rows[0].count, 0);

      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        DEMO_ORGANIZATION_SEED.id,
      ]);

      result = await client.query("SELECT id FROM organizations");
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [DEMO_ORGANIZATION_SEED.id],
      );

      result = await client.query("SELECT id FROM users");
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [SEEDED_ADMIN_USER_SEED.id],
      );

      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        ORG_A,
      ]);

      for (const tableName of TENANT_RLS_TABLES) {
        result = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdentifier(tableName)}`);
        assert.equal(
          result.rows[0].count,
          expectedTenantRowCount(tableName, ORG_A),
          `${tableName} should expose only org A rows`,
        );
      }

      result = await client.query("SELECT id FROM messages ORDER BY sequence_number");
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [M1_FIXTURES[ORG_A].messageFirst, M1_FIXTURES[ORG_A].messageSecond],
      );

      await client.query(
        "SELECT set_config('app.current_organization_id', $1, false)",
        [ORG_B],
      );

      for (const tableName of TENANT_RLS_TABLES) {
        result = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdentifier(tableName)}`);
        assert.equal(
          result.rows[0].count,
          expectedTenantRowCount(tableName, ORG_B),
          `${tableName} should expose only org B rows`,
        );
      }

      await client.query("SELECT set_config('app.current_organization_id', '', false)");
      await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
      result = await client.query("SELECT count(*)::int AS count FROM clients");
      assert.equal(result.rows[0].count, 2);
    });
  } finally {
    await adminClient.query(`DROP OWNED BY ${roleIdentifier}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  }
}

function connectionConfigFromAdmin(adminConfig, overrides = {}) {
  return {
    host: adminConfig.host,
    port: adminConfig.port,
    database: adminConfig.database,
    password: TEST_DB.password,
    ...overrides,
  };
}

async function insertM1TenantSlice(client, organizationId) {
  const fixture = M1_FIXTURES[organizationId];
  const suffix = organizationId === ORG_A ? "a" : "b";

  await client.query(
    `
      INSERT INTO organizations (id, name, description, timezone, locale, status)
      VALUES ($1, $2, $3, 'UTC', 'ru-RU', 'active')
    `,
    [organizationId, `M1 Organization ${suffix.toUpperCase()}`, "M1 tenant isolation fixture."],
  );
  await client.query(
    `
      INSERT INTO users (id, organization_id, telegram_username, email, display_name, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
    `,
    [
      fixture.user,
      organizationId,
      `m1_manager_${suffix}`,
      `m1-manager-${suffix}@example.bridge.local`,
      `M1 Manager ${suffix.toUpperCase()}`,
    ],
  );
  await client.query(
    "INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1, $2, $3)",
    [fixture.user, ROLE_MANAGER, organizationId],
  );
  await client.query(
    `
      INSERT INTO auth_sessions (id, user_id, organization_id, issued_at, expires_at, ip, user_agent)
      VALUES ($1, $2, $3, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '127.0.0.1', 'node-test')
    `,
    [fixture.session, fixture.user, organizationId],
  );
  await client.query(
    `
      INSERT INTO login_codes (
        id,
        user_id,
        organization_id,
        code_hash,
        purpose,
        expires_at,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'telegram_login',
        '2026-01-01T00:05:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `,
    [fixture.loginCode, fixture.user, organizationId, `login-code-${suffix}`],
  );
  await client.query(
    `
      INSERT INTO invitations (
        id,
        organization_id,
        contact_type,
        contact_value,
        role_id,
        token_hash,
        expires_at,
        created_by,
        created_at
      )
      VALUES (
        $1,
        $2,
        'email',
        $3,
        $4,
        $5,
        '2026-01-08T00:00:00.000Z',
        $6,
        '2026-01-01T00:00:00.000Z'
      )
    `,
    [
      fixture.invitation,
      organizationId,
      `invite-${suffix}@example.bridge.local`,
      ROLE_MANAGER,
      `invitation-${suffix}`,
      fixture.user,
    ],
  );
  await client.query(
    `
      INSERT INTO configurations (id, organization_id, key, value, version, updated_by, updated_at)
      VALUES ($1, $2, 'core.routing', '{"mode":"manual"}'::jsonb, 1, $3, '2026-01-01T00:00:00.000Z')
    `,
    [fixture.config, organizationId, fixture.user],
  );
  await client.query(
    `
      INSERT INTO audit_events (
        id,
        organization_id,
        actor_user_id,
        actor_type,
        action,
        object_type,
        object_id,
        result,
        request_id,
        ip,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, 'user', 'message.received', 'message', $4, 'success', $5, '127.0.0.1', '{}'::jsonb, '2026-01-01T00:00:00.000Z')
    `,
    [
      fixture.audit,
      organizationId,
      fixture.user,
      fixture.messageFirst,
      `request-${suffix}`,
    ],
  );
  await client.query(
    "INSERT INTO clients (id, organization_id, display_name) VALUES ($1, $2, $3)",
    [fixture.client, organizationId, `Client ${suffix.toUpperCase()}`],
  );
  await client.query(
    "INSERT INTO client_notes (id, organization_id, client_id, author_user_id, body) VALUES ($1, $2, $3, $4, $5)",
    [
      fixture.clientNote,
      organizationId,
      fixture.client,
      fixture.user,
      `Client note ${suffix.toUpperCase()}`,
    ],
  );
  await client.query(
    "INSERT INTO client_tags (id, organization_id, client_id, tag, created_by) VALUES ($1, $2, $3, $4, $5)",
    [
      fixture.clientTag,
      organizationId,
      fixture.client,
      `segment-${suffix}`,
      fixture.user,
    ],
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
    [fixture.endpoint, organizationId, fixture.client, `web-chat-${suffix}`],
  );
  await client.query(
    "INSERT INTO conversations (id, organization_id, client_id, status, created_at) VALUES ($1, $2, $3, 'open', '2026-01-01T00:00:00.000Z')",
    [fixture.conversation, organizationId, fixture.client],
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
      VALUES
        ($1, $2, $3, $4, 'web_chat', 'inbound', 'client', 1, 'text', '{"text":"first"}'::jsonb, 'received', '2026-01-01T00:00:01.000Z'),
        ($5, $2, $3, $4, 'web_chat', 'outbound', 'manager', 2, 'text', '{"text":"second"}'::jsonb, 'sent', '2026-01-01T00:00:02.000Z')
    `,
    [
      fixture.messageFirst,
      organizationId,
      fixture.conversation,
      fixture.endpoint,
      fixture.messageSecond,
    ],
  );
  await client.query(
    `
      INSERT INTO attachments (id, organization_id, message_id, kind, storage_ref, mime, size, metadata)
      VALUES ($1, $2, $3, 'image', 's3://bridge-test/m1.png', 'image/png', 128, '{}'::jsonb)
    `,
    [fixture.attachment, organizationId, fixture.messageFirst],
  );
  await client.query(
    `
      INSERT INTO message_delivery_attempts (
        id,
        organization_id,
        message_id,
        adapter,
        attempt_no,
        status,
        created_at
      )
      VALUES ($1, $2, $3, 'web_chat', 1, 'sent', '2026-01-01T00:00:03.000Z')
    `,
    [fixture.attempt, organizationId, fixture.messageSecond],
  );
}

async function assertM1Invariants(client) {
  const fixture = M1_FIXTURES[ORG_A];

  await assert.rejects(
    client.query(
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
          status
        )
        VALUES ($1, $2, $3, $4, 'web_chat', 'inbound', 'client', 3, 'text', '{"text":"duplicate"}'::jsonb, 'received')
      `,
      [fixture.messageFirst, ORG_A, fixture.conversation, fixture.endpoint],
    ),
    /duplicate key value violates unique constraint/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO communication_endpoints (
          id,
          organization_id,
          client_id,
          channel,
          external_id
        )
        VALUES ($1, $2, $3, 'web_chat', 'web-chat-a')
      `,
      ["10000000-0000-4000-8000-000000000499", ORG_A, fixture.client],
    ),
    /duplicate key value violates unique constraint/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO configurations (id, organization_id, key, value, version, updated_by)
        VALUES ($1, $2, 'core.routing', '{}'::jsonb, 1, $3)
      `,
      ["10000000-0000-4000-8000-000000000999", ORG_A, fixture.user],
    ),
    /duplicate key value violates unique constraint/,
  );

  const orderedMessages = await client.query(
    "SELECT id FROM messages WHERE endpoint_id = $1 ORDER BY sequence_number",
    [fixture.endpoint],
  );
  assert.deepEqual(
    orderedMessages.rows.map((row) => row.id),
    [fixture.messageFirst, fixture.messageSecond],
  );

  await client.query(
    `
      UPDATE configurations
      SET value = '{"mode":"auto"}'::jsonb,
          version = 2,
          updated_at = '2026-01-01T00:01:00.000Z'
      WHERE id = $1
    `,
    [fixture.config],
  );
  const history = await client.query(
    `
      SELECT version, value
      FROM configuration_history
      WHERE organization_id = $1 AND config_key = 'core.routing'
      ORDER BY version
    `,
    [ORG_A],
  );
  assert.deepEqual(
    history.rows.map((row) => [row.version, row.value.mode]),
    [
      [1, "manual"],
      [2, "auto"],
    ],
  );

  await assert.rejects(
    client.query("UPDATE configuration_history SET version = version + 1 WHERE organization_id = $1", [
      ORG_A,
    ]),
    /append-only/,
  );
  await assert.rejects(
    client.query("DELETE FROM audit_events WHERE id = $1", [fixture.audit]),
    /append-only/,
  );
}

describe("SVC-DATA M1 migrations", { timeout: 300_000 }, () => {
  it("runs up, seeds deterministic data, enforces RLS, then runs down and up again", async () => {
    const container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: TEST_DB.database,
        POSTGRES_USER: TEST_DB.user,
        POSTGRES_PASSWORD: TEST_DB.password,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    try {
      const adminConfig = connectionConfig(container);

      await withClient(adminConfig, async (client) => {
        await runMigrations({ databaseUrl: adminConfig, direction: "up" });
        await runSeeds({ client });
        await assertM1Schema(client, { expectSeedData: true });
        await insertM1TenantSlice(client, ORG_A);
        await insertM1TenantSlice(client, ORG_B);
        await assertM1Invariants(client);
        await assertRlsIsolation(adminConfig, client);

        await runMigrations({
          databaseUrl: adminConfig,
          direction: "down",
          count: Number.POSITIVE_INFINITY,
        });
        await assertM1SchemaDropped(client);

        await runMigrations({ databaseUrl: adminConfig, direction: "up" });
        await assertM1Schema(client, { expectSeedData: false });
      });
    } finally {
      await container.stop();
    }
  });
});
