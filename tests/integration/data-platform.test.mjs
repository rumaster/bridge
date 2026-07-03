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
import {
  formatPgVector,
  TEST_EMBEDDING_DIMENSIONS,
} from "../../packages/testing/src/db/factories.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_test",
  user: "bridge_test",
  password: "bridge_test",
};
const DATA_PLATFORM_TABLES = [
  "adapter_capabilities",
  "attachments",
  "audit_events",
  "auth_sessions",
  "channels",
  "client_identity_links",
  "client_notes",
  "client_tags",
  "clients",
  "communication_endpoints",
  "configuration_history",
  "configurations",
  "conversations",
  "invitations",
  "knowledge_chunks",
  "knowledge_documents",
  "login_codes",
  "message_delivery_attempts",
  "messages",
  "organizations",
  "roles",
  "user_roles",
  "users",
];
const TENANT_RLS_TABLES = [
  "adapter_capabilities",
  "attachments",
  "audit_events",
  "auth_sessions",
  "channels",
  "client_identity_links",
  "client_notes",
  "client_tags",
  "clients",
  "communication_endpoints",
  "configuration_history",
  "configurations",
  "conversations",
  "invitations",
  "knowledge_chunks",
  "knowledge_documents",
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
    knowledgeDocument: "10000000-0000-4000-8000-000000000b01",
    knowledgeChunkNear: "10000000-0000-4000-8000-000000000b11",
    knowledgeChunkFar: "10000000-0000-4000-8000-000000000b12",
    identityLink: "10000000-0000-4000-8000-000000000c01",
    identityLinkReplacement: "10000000-0000-4000-8000-000000000c11",
    channel: "10000000-0000-4000-8000-000000000d01",
    capability: "10000000-0000-4000-8000-000000000d11",
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
    knowledgeDocument: "10000000-0000-4000-8000-000000000b02",
    knowledgeChunkNear: "10000000-0000-4000-8000-000000000b21",
    knowledgeChunkFar: "10000000-0000-4000-8000-000000000b22",
    identityLink: "10000000-0000-4000-8000-000000000c02",
    identityLinkReplacement: "10000000-0000-4000-8000-000000000c12",
    channel: "10000000-0000-4000-8000-000000000d02",
    capability: "10000000-0000-4000-8000-000000000d12",
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

function axisEmbedding(firstCoordinate) {
  const embedding = Array(TEST_EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = firstCoordinate;
  return embedding;
}

function expectedTenantRowCount(tableName, organizationId) {
  if (tableName === "messages" || tableName === "knowledge_chunks") {
    return 2;
  }

  if (tableName === "configuration_history") {
    return organizationId === ORG_A ? 2 : 1;
  }

  if (tableName === "client_identity_links") {
    return organizationId === ORG_A ? 2 : 1;
  }

  return 1;
}

async function assertDataPlatformSchema(client, { expectSeedData }) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      ORDER BY table_name
    `,
    [DATA_PLATFORM_TABLES],
  );

  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    DATA_PLATFORM_TABLES,
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
             to_regclass('public.messages_endpoint_sequence_number_idx') AS messages_endpoint_sequence_number_idx,
             to_regclass('public.knowledge_chunks_embedding_hnsw_idx') AS knowledge_chunks_embedding_hnsw_idx
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
  assert.equal(
    indexes.rows[0].knowledge_chunks_embedding_hnsw_idx,
    "knowledge_chunks_embedding_hnsw_idx",
  );

  const embeddingColumn = await client.query(
    `
      SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'knowledge_chunks'
        AND attribute.attname = 'embedding'
        AND NOT attribute.attisdropped
    `,
  );
  assert.equal(embeddingColumn.rows[0].type, `vector(${TEST_EMBEDDING_DIMENSIONS})`);

  const vectorIndex = await client.query(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'knowledge_chunks'
        AND indexname = 'knowledge_chunks_embedding_hnsw_idx'
    `,
  );
  assert.match(vectorIndex.rows[0].indexdef, /USING hnsw/);
  assert.match(vectorIndex.rows[0].indexdef, /vector_l2_ops/);

  const channelColumns = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'channels'
      ORDER BY column_name
    `,
  );
  const channelColumnNames = channelColumns.rows.map((row) => row.column_name);
  assert.equal(channelColumnNames.includes("credentials_ref"), true);
  assert.deepEqual(
    channelColumnNames.filter((columnName) =>
      /(^|_)(api_key|access_key|password|secret|token)(_|$)/.test(columnName),
    ),
    [],
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

  const seededAdminRoles = await client.query(
    `
      SELECT r.code
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND ur.organization_id = $2
      ORDER BY r.code
    `,
    [SEEDED_ADMIN_USER_SEED.id, DEMO_ORGANIZATION_SEED.id],
  );
  assert.deepEqual(
    seededAdminRoles.rows.map((row) => row.code),
    ["administrator"],
  );
}

async function assertDataPlatformSchemaDropped(client) {
  const objectColumns = DATA_PLATFORM_TABLES.map(
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
    ...Object.fromEntries(DATA_PLATFORM_TABLES.map((tableName) => [tableName, null])),
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
  await adminClient.query(`GRANT SELECT ON ${DATA_PLATFORM_TABLES.map(quoteIdentifier).join(", ")} TO ${roleIdentifier}`);

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
      INSERT INTO auth_sessions (
        id,
        user_id,
        organization_id,
        token_hash,
        issued_at,
        expires_at,
        ip,
        user_agent
      )
      VALUES ($1, $2, $3, $4, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '127.0.0.1', 'node-test')
    `,
    [fixture.session, fixture.user, organizationId, `session-token-${suffix}`],
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

  const vectorOffsets = organizationId === ORG_A
    ? { near: 1, far: 2 }
    : { near: 0, far: 3 };

  await client.query(
    `
      INSERT INTO knowledge_documents (
        id,
        organization_id,
        title,
        source,
        status,
        indexed_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'indexed',
        '2026-01-01T00:02:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:02:00.000Z'
      )
    `,
    [
      fixture.knowledgeDocument,
      organizationId,
      `Knowledge ${suffix.toUpperCase()}`,
      `manual://kb/${suffix}`,
    ],
  );
  await client.query(
    `
      INSERT INTO knowledge_chunks (
        id,
        organization_id,
        document_id,
        chunk_no,
        content,
        embedding,
        metadata,
        created_at
      )
      VALUES
        ($1, $2, $3, 1, $4, $5::vector, $6::jsonb, '2026-01-01T00:02:01.000Z'),
        ($7, $2, $3, 2, $8, $9::vector, $10::jsonb, '2026-01-01T00:02:02.000Z')
    `,
    [
      fixture.knowledgeChunkNear,
      organizationId,
      fixture.knowledgeDocument,
      `Nearest tenant ${suffix.toUpperCase()} knowledge chunk`,
      formatPgVector(axisEmbedding(vectorOffsets.near)),
      JSON.stringify({ section: "nearest" }),
      fixture.knowledgeChunkFar,
      `Fallback tenant ${suffix.toUpperCase()} knowledge chunk`,
      formatPgVector(axisEmbedding(vectorOffsets.far)),
      JSON.stringify({ section: "fallback" }),
    ],
  );
  await client.query(
    `
      INSERT INTO client_identity_links (
        id,
        organization_id,
        client_id,
        endpoint_id,
        link_type,
        evidence,
        created_by,
        created_by_actor_type,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'user', '2026-01-01T00:03:00.000Z')
    `,
    [
      fixture.identityLink,
      organizationId,
      fixture.client,
      fixture.endpoint,
      organizationId === ORG_A ? "manual" : "automatic",
      JSON.stringify({ source: "integration-test", confidence: 1 }),
      fixture.user,
    ],
  );
  await client.query(
    `
      INSERT INTO channels (
        id,
        organization_id,
        channel_type,
        name,
        status,
        credentials_ref,
        config,
        last_check_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'telegram',
        $3,
        'connected',
        $4,
        $5::jsonb,
        '2026-01-01T00:04:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:04:00.000Z'
      )
    `,
    [
      fixture.channel,
      organizationId,
      `Telegram ${suffix.toUpperCase()}`,
      `secret://telegram/${organizationId}/main`,
      JSON.stringify({ username: `bridge_${suffix}_bot` }),
    ],
  );
  await client.query(
    `
      INSERT INTO adapter_capabilities (
        id,
        organization_id,
        channel_id,
        capability,
        supported,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'text',
        true,
        '{"max_length":4096}'::jsonb,
        '2026-01-01T00:04:01.000Z',
        '2026-01-01T00:04:01.000Z'
      )
    `,
    [fixture.capability, organizationId, fixture.channel],
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

async function assertM2Invariants(client) {
  const fixture = M1_FIXTURES[ORG_A];

  const nearestChunks = await client.query(
    `
      SELECT id
      FROM knowledge_chunks
      WHERE organization_id = $1
      ORDER BY embedding <-> $2::vector
      LIMIT 2
    `,
    [ORG_A, formatPgVector(axisEmbedding(0))],
  );
  assert.deepEqual(
    nearestChunks.rows.map((row) => row.id),
    [fixture.knowledgeChunkNear, fixture.knowledgeChunkFar],
  );

  const channel = await client.query(
    "SELECT credentials_ref, config FROM channels WHERE id = $1",
    [fixture.channel],
  );
  assert.equal(channel.rows[0].credentials_ref, `secret://telegram/${ORG_A}/main`);
  assert.equal(Object.hasOwn(channel.rows[0].config, "token"), false);
  assert.equal(Object.hasOwn(channel.rows[0].config, "secret"), false);

  await assert.rejects(
    client.query(
      `
        INSERT INTO channels (
          id,
          organization_id,
          channel_type,
          name,
          status,
          credentials_ref,
          config
        )
        VALUES (
          '10000000-0000-4000-8000-000000000d99',
          $1,
          'telegram',
          'Leaky Telegram',
          'disabled',
          'secret://telegram/leaky',
          '{"token":"raw-token"}'::jsonb
        )
      `,
      [ORG_A],
    ),
    /channels_config_no_inline_secrets|violates check constraint/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO client_identity_links (
          id,
          organization_id,
          client_id,
          endpoint_id,
          link_type,
          evidence,
          created_by,
          created_by_actor_type
        )
        VALUES ($1, $2, $3, $4, 'manual', '{}'::jsonb, $5, 'user')
      `,
      [
        fixture.identityLinkReplacement,
        ORG_A,
        fixture.client,
        fixture.endpoint,
        fixture.user,
      ],
    ),
    /client_identity_links_active_endpoint_unique|duplicate key value/,
  );

  await client.query(
    `
      UPDATE client_identity_links
      SET reverted_at = '2026-01-01T00:05:00.000Z',
          reverted_by = $1,
          reverted_by_actor_type = 'user',
          reverted_reason = 'manual undo'
      WHERE id = $2
    `,
    [fixture.user, fixture.identityLink],
  );
  await client.query(
    `
      INSERT INTO client_identity_links (
        id,
        organization_id,
        client_id,
        endpoint_id,
        link_type,
        evidence,
        created_by,
        created_by_actor_type,
        created_at
      )
      VALUES ($1, $2, $3, $4, 'manual', '{"source":"replacement"}'::jsonb, $5, 'user', '2026-01-01T00:06:00.000Z')
    `,
    [
      fixture.identityLinkReplacement,
      ORG_A,
      fixture.client,
      fixture.endpoint,
      fixture.user,
    ],
  );

  const links = await client.query(
    `
      SELECT id, reverted_at
      FROM client_identity_links
      WHERE organization_id = $1 AND endpoint_id = $2
      ORDER BY created_at
    `,
    [ORG_A, fixture.endpoint],
  );
  assert.deepEqual(
    links.rows.map((row) => [row.id, row.reverted_at === null]),
    [
      [fixture.identityLink, false],
      [fixture.identityLinkReplacement, true],
    ],
  );
}

async function assertKnowledgeVectorSearchIsolation(adminConfig, adminClient) {
  const roleName = `kb_vector_probe_${process.pid}`;
  const roleIdentifier = quoteIdentifier(roleName);

  await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  await adminClient.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD 'bridge_test'`);
  await adminClient.query(`GRANT USAGE ON SCHEMA app, public TO ${roleIdentifier}`);
  await adminClient.query(
    `GRANT SELECT ON knowledge_documents, knowledge_chunks TO ${roleIdentifier}`,
  );

  try {
    await withClient(connectionConfigFromAdmin(adminConfig, { user: roleName }), async (client) => {
      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        ORG_A,
      ]);

      let result = await client.query(
        `
          SELECT id, organization_id
          FROM knowledge_chunks
          WHERE organization_id = app.current_organization_id()
          ORDER BY embedding <-> $1::vector
          LIMIT 10
        `,
        [formatPgVector(axisEmbedding(0))],
      );
      assert.deepEqual(
        result.rows.map((row) => [row.id, row.organization_id]),
        [
          [M1_FIXTURES[ORG_A].knowledgeChunkNear, ORG_A],
          [M1_FIXTURES[ORG_A].knowledgeChunkFar, ORG_A],
        ],
      );

      result = await client.query(
        `
          SELECT id
          FROM knowledge_chunks
          ORDER BY embedding <-> $1::vector
          LIMIT 10
        `,
        [formatPgVector(axisEmbedding(0))],
      );
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [
          M1_FIXTURES[ORG_A].knowledgeChunkNear,
          M1_FIXTURES[ORG_A].knowledgeChunkFar,
        ],
      );

      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        ORG_B,
      ]);
      result = await client.query(
        `
          SELECT id, organization_id
          FROM knowledge_chunks
          WHERE organization_id = app.current_organization_id()
          ORDER BY embedding <-> $1::vector
          LIMIT 1
        `,
        [formatPgVector(axisEmbedding(0))],
      );
      assert.deepEqual(
        result.rows.map((row) => [row.id, row.organization_id]),
        [[M1_FIXTURES[ORG_B].knowledgeChunkNear, ORG_B]],
      );
    });
  } finally {
    await adminClient.query(`DROP OWNED BY ${roleIdentifier}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  }
}

describe("SVC-DATA M2 migrations", { timeout: 300_000 }, () => {
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
        await assertDataPlatformSchema(client, { expectSeedData: true });
        await insertM1TenantSlice(client, ORG_A);
        await insertM1TenantSlice(client, ORG_B);
        await assertM1Invariants(client);
        await assertM2Invariants(client);
        await assertRlsIsolation(adminConfig, client);
        await assertKnowledgeVectorSearchIsolation(adminConfig, client);

        await runMigrations({
          databaseUrl: adminConfig,
          direction: "down",
          count: Number.POSITIVE_INFINITY,
        });
        await assertDataPlatformSchemaDropped(client);

        await runMigrations({ databaseUrl: adminConfig, direction: "up" });
        await assertDataPlatformSchema(client, { expectSeedData: false });
      });
    } finally {
      await container.stop();
    }
  });
});
