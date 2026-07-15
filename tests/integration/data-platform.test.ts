import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.js";
import { runSeeds } from "../../scripts/db-seed.js";
import {
  DEMO_ORGANIZATION_SEED,
  ROLE_SEEDS,
  SEEDED_ADMIN_USER_SEED,
} from "../../packages/testing/src/db/m0-seed-data.js";
import {
  formatPgVector,
  TEST_EMBEDDING_DIMENSIONS,
} from "../../packages/testing/src/db/factories.js";
import { validateWorkflowSchema } from "../../services/fbp-engine/src/schema/validate-workflow.js";

const execFileAsync = promisify(execFile);
const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_test",
  user: "bridge_test",
  password: "bridge_test",
};
const RESTORE_DB = "bridge_restore";
const APP_BACKUP_FILE = "/tmp/bridge-app-m5.dump";
const RF_BACKUP_FILE = "/tmp/bridge-rf-m5.dump";
const EDGE_RF_TABLES = ["edge_message_buffer"];
const EDGE_FIXTURES = {
  endpoint: "20000000-0000-4000-8000-000000000401",
  first: "20000000-0000-4000-8000-000000000501",
  second: "20000000-0000-4000-8000-000000000502",
  duplicate: "20000000-0000-4000-8000-000000000503",
  firstIdempotencyKey: "20000000-0000-4000-8000-000000000601",
  secondIdempotencyKey: "20000000-0000-4000-8000-000000000602",
};
const DATA_PLATFORM_TABLES = [
  "adapter_capabilities",
  "attachments",
  "audit_events",
  "auth_sessions",
  "broadcast_messages",
  "broadcast_recipients",
  "broadcast_stats",
  "broadcasts",
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
  "notification_settings",
  "notifications",
  "organizations",
  "outbox_events",
  "roles",
  "user_roles",
  "users",
  "workflow_execution_logs",
  "workflow_instance_state",
  "workflow_instances",
  "workflow_versions",
  "workflows",
];
const TENANT_RLS_TABLES = [
  "adapter_capabilities",
  "attachments",
  "audit_events",
  "auth_sessions",
  "broadcast_messages",
  "broadcast_recipients",
  "broadcast_stats",
  "broadcasts",
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
  "notification_settings",
  "notifications",
  "organizations",
  "outbox_events",
  "user_roles",
  "users",
  "workflow_execution_logs",
  "workflow_instance_state",
  "workflow_instances",
  "workflow_versions",
  "workflows",
];
const TENANT_ORGANIZATION_ID_TABLES = TENANT_RLS_TABLES.filter(
  (tableName) => tableName !== "organizations" && tableName !== "users",
);
const ORG_A = "10000000-0000-4000-8000-000000000101";
const ORG_B = "10000000-0000-4000-8000-000000000102";
const ROLE_MANAGER = "00000000-0000-4000-8000-000000000003";
const SEEDED_WORKFLOW_CASES = [
  {
    defaultVersionId: "00000000-0000-4000-8000-000000000811",
    id: "00000000-0000-4000-8000-000000000801",
    name: "Автоответчик обращений",
    status: "active",
    versionId: "00000000-0000-4000-8000-000000000811",
  },
  {
    defaultVersionId: "00000000-0000-4000-8000-000000000812",
    id: "00000000-0000-4000-8000-000000000802",
    name: "Квалификация лидов",
    status: "draft",
    versionId: "00000000-0000-4000-8000-000000000812",
  },
];
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
    workflow: "10000000-0000-4000-8000-000000000e01",
    workflowVersionFirst: "10000000-0000-4000-8000-000000000e11",
    workflowVersionSecond: "10000000-0000-4000-8000-000000000e12",
    workflowInstance: "10000000-0000-4000-8000-000000000e21",
    workflowLogStarted: "10000000-0000-4000-8000-000000000e31",
    workflowLogFinished: "10000000-0000-4000-8000-000000000e32",
    outboxEvent: "10000000-0000-4000-8000-000000000f01",
    outboxMessage: "10000000-0000-4000-8000-000000000f11",
    outboxCommitEvent: "10000000-0000-4000-8000-000000000f21",
    broadcast: "10000000-0000-4000-8000-000000001001",
    broadcastRecipient: "10000000-0000-4000-8000-000000001011",
    broadcastMessage: "10000000-0000-4000-8000-000000001021",
    notification: "10000000-0000-4000-8000-000000001101",
    notificationSetting: "10000000-0000-4000-8000-000000001111",
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
    workflow: "10000000-0000-4000-8000-000000000e02",
    workflowVersionFirst: "10000000-0000-4000-8000-000000000e13",
    workflowVersionSecond: "10000000-0000-4000-8000-000000000e14",
    workflowInstance: "10000000-0000-4000-8000-000000000e22",
    workflowLogStarted: "10000000-0000-4000-8000-000000000e33",
    workflowLogFinished: "10000000-0000-4000-8000-000000000e34",
    outboxEvent: "10000000-0000-4000-8000-000000000f02",
    outboxMessage: "10000000-0000-4000-8000-000000000f12",
    outboxCommitEvent: "10000000-0000-4000-8000-000000000f22",
    broadcast: "10000000-0000-4000-8000-000000001002",
    broadcastRecipient: "10000000-0000-4000-8000-000000001012",
    broadcastMessage: "10000000-0000-4000-8000-000000001022",
    notification: "10000000-0000-4000-8000-000000001102",
    notificationSetting: "10000000-0000-4000-8000-000000001112",
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
  if (
    tableName === "messages" ||
    tableName === "knowledge_chunks" ||
    tableName === "workflow_versions" ||
    tableName === "workflow_execution_logs"
  ) {
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
             to_regclass('public.knowledge_chunks_embedding_hnsw_idx') AS knowledge_chunks_embedding_hnsw_idx,
             to_regclass('public.clients_anonymized_at_idx') AS clients_anonymized_at_idx,
             to_regclass('public.communication_endpoints_client_channel_idx') AS communication_endpoints_client_channel_idx,
             to_regclass('public.audit_events_object_lookup_idx') AS audit_events_object_lookup_idx,
             to_regclass('public.broadcast_messages_message_id_idx') AS broadcast_messages_message_id_idx,
             to_regclass('public.broadcast_recipients_status_idx') AS broadcast_recipients_status_idx,
             to_regclass('public.notifications_status_created_at_idx') AS notifications_status_created_at_idx,
             to_regclass('public.notification_settings_user_category_channel_unique') AS notification_settings_user_category_channel_unique
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
  assert.equal(indexes.rows[0].clients_anonymized_at_idx, "clients_anonymized_at_idx");
  assert.equal(
    indexes.rows[0].communication_endpoints_client_channel_idx,
    "communication_endpoints_client_channel_idx",
  );
  assert.equal(
    indexes.rows[0].audit_events_object_lookup_idx,
    "audit_events_object_lookup_idx",
  );
  assert.equal(
    indexes.rows[0].broadcast_messages_message_id_idx,
    "broadcast_messages_message_id_idx",
  );
  assert.equal(
    indexes.rows[0].broadcast_recipients_status_idx,
    "broadcast_recipients_status_idx",
  );
  assert.equal(
    indexes.rows[0].notifications_status_created_at_idx,
    "notifications_status_created_at_idx",
  );
  assert.equal(
    indexes.rows[0].notification_settings_user_category_channel_unique,
    "notification_settings_user_category_channel_unique",
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

  const functions = await client.query(
    `
      SELECT to_regprocedure(
               'app.anonymize_client_personal_data(uuid,uuid,uuid,text,text)'
             ) AS anonymize_client_personal_data
    `,
  );
  assert.equal(
    functions.rows[0].anonymize_client_personal_data,
    "app.anonymize_client_personal_data(uuid,uuid,uuid,text,text)",
  );

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
  assert.equal(channelColumnNames.includes("credentials_envelope"), true);
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

  await assertSeededWorkflowCases(client);
}

async function assertSeededWorkflowCases(client) {
  const workflowIds = SEEDED_WORKFLOW_CASES.map((workflow) => workflow.id);
  const workflows = await client.query(
    `
      SELECT id, name, status, default_version_id
      FROM workflows
      WHERE organization_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY id
    `,
    [DEMO_ORGANIZATION_SEED.id, workflowIds],
  );

  assert.deepEqual(
    workflows.rows.map((row) => ({
      defaultVersionId: row.default_version_id,
      id: row.id,
      name: row.name,
      status: row.status,
    })),
    SEEDED_WORKFLOW_CASES.map((workflow) => ({
      defaultVersionId: workflow.defaultVersionId,
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
    })),
  );

  const versions = await client.query(
    `
      SELECT id, workflow_id, version_no, schema, created_by
      FROM workflow_versions
      WHERE organization_id = $1
        AND workflow_id = ANY($2::uuid[])
      ORDER BY workflow_id, version_no
    `,
    [DEMO_ORGANIZATION_SEED.id, workflowIds],
  );

  assert.deepEqual(
    versions.rows.map((row) => ({
      createdBy: row.created_by,
      id: row.id,
      versionNo: Number(row.version_no),
      workflowId: row.workflow_id,
    })),
    SEEDED_WORKFLOW_CASES.map((workflow) => ({
      createdBy: SEEDED_ADMIN_USER_SEED.id,
      id: workflow.versionId,
      versionNo: 1,
      workflowId: workflow.id,
    })),
  );

  for (const row of versions.rows) {
    const validation = validateWorkflowSchema(row.schema);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  }

  await assertSeededBackendApiCallsAreAllowed(client, versions.rows);
}

/**
 * Каждый вызов Backend API из сидовой схемы обязан быть открыт в витрине
 * (`workflow_backend_api_allowlist`). Витрина закрыта по умолчанию и проверяется
 * при КАЖДОМ сохранении, поэтому забытая операция не ломает сид (он пишет SQL
 * напрямую), но делает сидовую схему непересохраняемой из редактора — витрина
 * возможностей молча превратилась бы в витрину поломок.
 */
async function assertSeededBackendApiCallsAreAllowed(client, versionRows) {
  const referenced = new Set();
  for (const row of versionRows) {
    for (const node of row.schema.nodes ?? []) {
      if (node.type === "backend-api" && typeof node.config?.operation_id === "string") {
        referenced.add(node.config.operation_id);
      }
    }
  }
  if (referenced.size === 0) return;

  const allowed = await client.query(
    `
      SELECT operation_id
      FROM workflow_backend_api_allowlist
      WHERE enabled AND operation_id = ANY($1::text[])
    `,
    [[...referenced]],
  );

  assert.deepEqual(
    allowed.rows.map((row) => row.operation_id).sort(),
    [...referenced].sort(),
    "все вызовы Backend API из сидовых схем открыты в витрине",
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
      to_regprocedure('app.anonymize_client_personal_data(uuid,uuid,uuid,text,text)') AS anonymize_client_personal_data,
      to_regprocedure('app.reject_append_only_mutation()') AS reject_append_only_mutation,
      to_regprocedure('app.record_configuration_history()') AS record_configuration_history
  `);

  assert.deepEqual(objects.rows[0], {
    ...Object.fromEntries(DATA_PLATFORM_TABLES.map((tableName) => [tableName, null])),
    current_organization_id: null,
    is_platform_operator: null,
    anonymize_client_personal_data: null,
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
  const person = organizationId === ORG_A
    ? {
      name: "Alice Example",
      email: "alice@example.bridge.local",
      phone: "+79000000001",
      attachment: "passport-a.png",
    }
    : {
      name: "Bob Example",
      email: "bob@example.bridge.local",
      phone: "+79000000002",
      attachment: "passport-b.png",
    };

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
    [fixture.client, organizationId, `${person.name} ${person.phone}`],
  );
  await client.query(
    "INSERT INTO client_notes (id, organization_id, client_id, author_user_id, body) VALUES ($1, $2, $3, $4, $5)",
    [
      fixture.clientNote,
      organizationId,
      fixture.client,
      fixture.user,
      `Client note ${suffix.toUpperCase()}: ${person.name}, ${person.email}, ${person.phone}`,
    ],
  );
  await client.query(
    "INSERT INTO client_tags (id, organization_id, client_id, tag, created_by) VALUES ($1, $2, $3, $4, $5)",
    [
      fixture.clientTag,
      organizationId,
      fixture.client,
      `segment-${suffix}-${person.name.toLowerCase().replace(" ", "-")}`,
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
    [fixture.endpoint, organizationId, fixture.client, `web-chat-${suffix}:${person.email}:${person.phone}`],
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
        ($1, $2, $3, $4, 'web_chat', 'inbound', 'client', 1, 'text', $5::jsonb, 'received', '2026-01-01T00:00:01.000Z'),
        ($6, $2, $3, $4, 'web_chat', 'outbound', 'manager', 2, 'text', $7::jsonb, 'sent', '2026-01-01T00:00:02.000Z')
    `,
    [
      fixture.messageFirst,
      organizationId,
      fixture.conversation,
      fixture.endpoint,
      JSON.stringify({ text: `first from ${person.name} ${person.email} ${person.phone}` }),
      fixture.messageSecond,
      JSON.stringify({ text: `second to ${person.name}` }),
    ],
  );
  await client.query(
    `
      INSERT INTO attachments (id, organization_id, message_id, kind, storage_ref, mime, size, metadata)
      VALUES ($1, $2, $3, 'image', $4, 'image/png', 128, $5::jsonb)
    `,
    [
      fixture.attachment,
      organizationId,
      fixture.messageFirst,
      `s3://bridge-test/${person.attachment}`,
      JSON.stringify({ original_file_name: person.attachment, email: person.email }),
    ],
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
        error,
        created_at
      )
      VALUES ($1, $2, $3, 'web_chat', 1, 'sent', $4, '2026-01-01T00:00:03.000Z')
    `,
    [fixture.attempt, organizationId, fixture.messageSecond, `delivery trace for ${person.email}`],
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
        content,
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
        $5,
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
      `Knowledge ${suffix.toUpperCase()} instruction content`,
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
      JSON.stringify({
        source: "integration-test",
        confidence: 1,
        email: person.email,
        phone: person.phone,
      }),
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
        credentials_envelope,
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
        $6::jsonb,
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
      JSON.stringify({
        alg: "AES-256-GCM",
        ciphertext: `encrypted-${suffix}`,
        created_at: "2026-01-01T00:04:00.000Z",
        iv: `iv-${suffix}`,
        kid: "env:CHANNEL_SECRET_ENCRYPTION_KEY",
        tag: `tag-${suffix}`,
      }),
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

  await insertM3TenantSlice(client, organizationId);
  await insertM4TenantSlice(client, organizationId);
}

async function insertM3TenantSlice(client, organizationId) {
  const fixture = M1_FIXTURES[organizationId];
  const suffix = organizationId === ORG_A ? "a" : "b";

  await client.query(
    `
      INSERT INTO workflows (id, organization_id, name, status, created_at, updated_at)
      VALUES ($1, $2, $3, 'active', '2026-01-01T00:07:00.000Z', '2026-01-01T00:07:00.000Z')
    `,
    [fixture.workflow, organizationId, `Workflow ${suffix.toUpperCase()}`],
  );
  await client.query(
    `
      INSERT INTO workflow_versions (
        id,
        organization_id,
        workflow_id,
        version_no,
        schema,
        created_by,
        created_at
      )
      VALUES
        ($1, $2, $3, 1, $4::jsonb, $5, '2026-01-01T00:07:01.000Z'),
        ($6, $2, $3, 2, $7::jsonb, $5, '2026-01-01T00:07:02.000Z')
    `,
    [
      fixture.workflowVersionFirst,
      organizationId,
      fixture.workflow,
      JSON.stringify({ nodes: ["start"], edges: [] }),
      fixture.user,
      fixture.workflowVersionSecond,
      JSON.stringify({ nodes: ["start", "reply"], edges: [["start", "reply"]] }),
    ],
  );
  await client.query(
    `
      UPDATE workflows
      SET default_version_id = $1, updated_at = '2026-01-01T00:07:03.000Z'
      WHERE id = $2
    `,
    [fixture.workflowVersionSecond, fixture.workflow],
  );
  await client.query(
    `
      INSERT INTO workflow_instances (
        id,
        organization_id,
        workflow_id,
        version_id,
        status,
        started_at,
        finished_at,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'running',
        '2026-01-01T00:07:10.000Z',
        NULL,
        '2026-01-01T00:07:10.000Z'
      )
    `,
    [
      fixture.workflowInstance,
      organizationId,
      fixture.workflow,
      fixture.workflowVersionFirst,
    ],
  );
  await client.query(
    `
      INSERT INTO workflow_instance_state (instance_id, organization_id, state, updated_at)
      VALUES ($1, $2, $3::jsonb, '2026-01-01T00:07:11.000Z')
    `,
    [fixture.workflowInstance, organizationId, JSON.stringify({ cursor: "start" })],
  );
  await client.query(
    `
      INSERT INTO workflow_execution_logs (
        id,
        organization_id,
        instance_id,
        node_id,
        event,
        data,
        created_at
      )
      VALUES
        ($1, $2, $3, 'start', 'node.started', '{}'::jsonb, '2026-01-01T00:07:12.000Z'),
        ($4, $2, $3, 'start', 'node.finished', $5::jsonb, '2026-01-01T00:07:13.000Z')
    `,
    [
      fixture.workflowLogStarted,
      organizationId,
      fixture.workflowInstance,
      fixture.workflowLogFinished,
      JSON.stringify({ output: `ack-${suffix}` }),
    ],
  );
  await client.query(
    `
      INSERT INTO outbox_events (
        id,
        organization_id,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        status,
        created_at
      )
      VALUES (
        $1,
        $2,
        'message',
        $3,
        'message.received',
        $4::jsonb,
        'pending',
        '2026-01-01T00:07:20.000Z'
      )
    `,
    [
      fixture.outboxEvent,
      organizationId,
      fixture.messageFirst,
      JSON.stringify({ conversation_id: fixture.conversation }),
    ],
  );
}

async function insertM4TenantSlice(client, organizationId) {
  const fixture = M1_FIXTURES[organizationId];
  const suffix = organizationId === ORG_A ? "a" : "b";

  await client.query(
    `
      INSERT INTO broadcasts (
        id,
        organization_id,
        name,
        status,
        template,
        filter,
        schedule,
        rate_limit,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'running',
        $4::jsonb,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb,
        $8,
        '2026-01-01T00:09:00.000Z',
        '2026-01-01T00:09:01.000Z'
      )
    `,
    [
      fixture.broadcast,
      organizationId,
      `Broadcast ${suffix.toUpperCase()}`,
      JSON.stringify({ type: "text", body: `Hello ${suffix}` }),
      JSON.stringify({ tags: [`segment-${suffix}`] }),
      JSON.stringify({ mode: "immediate" }),
      JSON.stringify({ per_minute: 120 }),
      fixture.user,
    ],
  );

  await client.query(
    `
      INSERT INTO broadcast_recipients (
        id,
        organization_id,
        broadcast_id,
        client_id,
        endpoint_id,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'sent',
        '2026-01-01T00:09:02.000Z',
        '2026-01-01T00:09:03.000Z'
      )
    `,
    [
      fixture.broadcastRecipient,
      organizationId,
      fixture.broadcast,
      fixture.client,
      fixture.endpoint,
    ],
  );

  await client.query(
    `
      INSERT INTO broadcast_messages (
        id,
        organization_id,
        broadcast_id,
        message_id,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'sent',
        '2026-01-01T00:09:04.000Z',
        '2026-01-01T00:09:05.000Z'
      )
    `,
    [
      fixture.broadcastMessage,
      organizationId,
      fixture.broadcast,
      fixture.messageSecond,
    ],
  );

  await client.query(
    `
      INSERT INTO broadcast_stats (
        broadcast_id,
        organization_id,
        prepared,
        sent,
        delivered,
        failed,
        updated_at
      )
      VALUES ($1, $2, 1, 1, 0, 0, '2026-01-01T00:09:06.000Z')
    `,
    [fixture.broadcast, organizationId],
  );

  await client.query(
    `
      INSERT INTO notifications (
        id,
        organization_id,
        recipient_user_id,
        category,
        title,
        body,
        payload,
        status,
        created_at,
        read_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'warning',
        $4,
        $5,
        $6::jsonb,
        'new',
        '2026-01-01T00:09:07.000Z',
        NULL
      )
    `,
    [
      fixture.notification,
      organizationId,
      fixture.user,
      `Notification ${suffix.toUpperCase()}`,
      `Broadcast ${suffix.toUpperCase()} requires attention`,
      JSON.stringify({ broadcast_id: fixture.broadcast }),
    ],
  );

  await client.query(
    `
      INSERT INTO notification_settings (
        id,
        organization_id,
        user_id,
        category,
        channel,
        enabled,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'warning',
        'web',
        true,
        '2026-01-01T00:09:08.000Z',
        '2026-01-01T00:09:08.000Z'
      )
    `,
    [fixture.notificationSetting, organizationId, fixture.user],
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
        VALUES ($1, $2, $3, 'web_chat', 'web-chat-a:alice@example.bridge.local:+79000000001')
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
    "SELECT credentials_ref, credentials_envelope, config FROM channels WHERE id = $1",
    [fixture.channel],
  );
  assert.equal(channel.rows[0].credentials_ref, `secret://telegram/${ORG_A}/main`);
  assert.equal(channel.rows[0].credentials_envelope.alg, "AES-256-GCM");
  assert.equal(
    Object.hasOwn(channel.rows[0].credentials_envelope, "ciphertext"),
    true,
  );
  assert.equal(Object.hasOwn(channel.rows[0].credentials_envelope, "token"), false);
  assert.equal(Object.hasOwn(channel.rows[0].credentials_envelope, "secret"), false);
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

async function assertM3Invariants(client) {
  const fixture = M1_FIXTURES[ORG_A];

  // Version pinning (ТЗ §13.10): default-версия и экземпляр закреплены за версиями.
  const workflow = await client.query(
    "SELECT default_version_id FROM workflows WHERE id = $1",
    [fixture.workflow],
  );
  assert.equal(workflow.rows[0].default_version_id, fixture.workflowVersionSecond);

  const instance = await client.query(
    "SELECT version_id FROM workflow_instances WHERE id = $1",
    [fixture.workflowInstance],
  );
  assert.equal(instance.rows[0].version_id, fixture.workflowVersionFirst);

  // Неизменяемость версии: повторная запись той же version_no отклоняется.
  await assert.rejects(
    client.query(
      `
        INSERT INTO workflow_versions (id, organization_id, workflow_id, version_no, schema, created_by)
        VALUES ($1, $2, $3, 1, '{}'::jsonb, $4)
      `,
      ["10000000-0000-4000-8000-000000000e91", ORG_A, fixture.workflow, fixture.user],
    ),
    /workflow_versions_workflow_version_no_unique|duplicate key value/,
  );

  // Неизменяемость версии: правка и удаление существующей версии отклоняются.
  await assert.rejects(
    client.query(
      "UPDATE workflow_versions SET schema = '{\"nodes\":[\"tampered\"]}'::jsonb WHERE id = $1",
      [fixture.workflowVersionFirst],
    ),
    /append-only/,
  );
  await assert.rejects(
    client.query("DELETE FROM workflow_versions WHERE id = $1", [
      fixture.workflowVersionFirst,
    ]),
    /append-only/,
  );

  // Монотонность version_no: неположительный номер отклоняется CHECK-ограничением.
  await assert.rejects(
    client.query(
      `
        INSERT INTO workflow_versions (id, organization_id, workflow_id, version_no, schema, created_by)
        VALUES ($1, $2, $3, 0, '{}'::jsonb, $4)
      `,
      ["10000000-0000-4000-8000-000000000e92", ORG_A, fixture.workflow, fixture.user],
    ),
    /workflow_versions_version_no_positive|violates check constraint/,
  );

  // Журнал исполнения (ТЗ §24.6): append-only.
  await assert.rejects(
    client.query("DELETE FROM workflow_execution_logs WHERE id = $1", [
      fixture.workflowLogStarted,
    ]),
    /append-only/,
  );

  // Атомарность outbox: событие и изменение агрегата откатываются вместе.
  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO messages (
        id, organization_id, conversation_id, endpoint_id, channel, direction,
        sender_type, sequence_number, type, content, status, created_at
      )
      VALUES ($1, $2, $3, $4, 'web_chat', 'inbound', 'client', 3, 'text', '{"text":"outbox-rollback"}'::jsonb, 'received', '2026-01-01T00:08:00.000Z')
    `,
    [fixture.outboxMessage, ORG_A, fixture.conversation, fixture.endpoint],
  );
  await client.query(
    `
      INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, event_type, payload, status)
      VALUES ('10000000-0000-4000-8000-000000000f31', $1, 'message', $2, 'message.received', '{}'::jsonb, 'pending')
    `,
    [ORG_A, fixture.outboxMessage],
  );
  await client.query("ROLLBACK");

  let persisted = await client.query(
    "SELECT count(*)::int AS count FROM messages WHERE id = $1",
    [fixture.outboxMessage],
  );
  assert.equal(persisted.rows[0].count, 0);
  persisted = await client.query(
    "SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id = $1",
    [fixture.outboxMessage],
  );
  assert.equal(persisted.rows[0].count, 0);

  // Атомарность outbox: событие и изменение агрегата коммитятся вместе.
  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO messages (
        id, organization_id, conversation_id, endpoint_id, channel, direction,
        sender_type, sequence_number, type, content, status, created_at
      )
      VALUES ($1, $2, $3, $4, 'web_chat', 'inbound', 'client', 3, 'text', '{"text":"outbox-commit"}'::jsonb, 'received', '2026-01-01T00:08:10.000Z')
    `,
    [fixture.outboxMessage, ORG_A, fixture.conversation, fixture.endpoint],
  );
  await client.query(
    `
      INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, event_type, payload, status)
      VALUES ($1, $2, 'message', $3, 'conversation.message_appended', '{"delivery":"async"}'::jsonb, 'pending')
    `,
    [fixture.outboxCommitEvent, ORG_A, fixture.outboxMessage],
  );
  await client.query("COMMIT");

  const committedMessage = await client.query(
    "SELECT count(*)::int AS count FROM messages WHERE id = $1",
    [fixture.outboxMessage],
  );
  assert.equal(committedMessage.rows[0].count, 1);

  // Выборка pending для доставки в порядке появления.
  const pending = await client.query(
    `
      SELECT id
      FROM outbox_events
      WHERE organization_id = $1 AND status = 'pending'
      ORDER BY created_at
    `,
    [ORG_A],
  );
  assert.deepEqual(
    pending.rows.map((row) => row.id),
    [fixture.outboxEvent, fixture.outboxCommitEvent],
  );

  // Идемпотентная доставка: публикация выставляет published_at и убирает из pending.
  await client.query(
    `
      UPDATE outbox_events
      SET status = 'published', published_at = '2026-01-01T00:08:20.000Z'
      WHERE id = $1
    `,
    [fixture.outboxEvent],
  );
  const remainingPending = await client.query(
    "SELECT id FROM outbox_events WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at",
    [ORG_A],
  );
  assert.deepEqual(
    remainingPending.rows.map((row) => row.id),
    [fixture.outboxCommitEvent],
  );

  // published требует published_at (инвариант согласованности статуса).
  await assert.rejects(
    client.query("UPDATE outbox_events SET status = 'published' WHERE id = $1", [
      fixture.outboxCommitEvent,
    ]),
    /outbox_events_published_at_consistency_check|violates check constraint/,
  );
}

async function assertM4Invariants(client) {
  const fixture = M1_FIXTURES[ORG_A];

  const broadcastMessage = await client.query(
    `
      SELECT bm.broadcast_id, bm.message_id, m.organization_id, m.id
      FROM broadcast_messages bm
      JOIN messages m
        ON m.id = bm.message_id
       AND m.organization_id = bm.organization_id
      WHERE bm.id = $1
    `,
    [fixture.broadcastMessage],
  );
  assert.deepEqual(broadcastMessage.rows[0], {
    broadcast_id: fixture.broadcast,
    message_id: fixture.messageSecond,
    organization_id: ORG_A,
    id: fixture.messageSecond,
  });

  const stats = await client.query(
    `
      SELECT prepared, sent, delivered, failed
      FROM broadcast_stats
      WHERE broadcast_id = $1 AND organization_id = $2
    `,
    [fixture.broadcast, ORG_A],
  );
  assert.deepEqual(stats.rows[0], {
    prepared: 1,
    sent: 1,
    delivered: 0,
    failed: 0,
  });

  await assert.rejects(
    client.query(
      `
        INSERT INTO broadcast_recipients (
          id,
          organization_id,
          broadcast_id,
          client_id,
          endpoint_id,
          status
        )
        VALUES (
          '10000000-0000-4000-8000-000000001091',
          $1,
          $2,
          $3,
          $4,
          'prepared'
        )
      `,
      [ORG_A, fixture.broadcast, fixture.client, fixture.endpoint],
    ),
    /broadcast_recipients_broadcast_endpoint_unique|duplicate key value/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO broadcast_messages (
          id,
          organization_id,
          broadcast_id,
          message_id,
          status
        )
        VALUES (
          '10000000-0000-4000-8000-000000001092',
          $1,
          $2,
          $3,
          'sent'
        )
      `,
      [ORG_A, fixture.broadcast, M1_FIXTURES[ORG_B].messageSecond],
    ),
    /broadcast_messages_message_organization_fk|violates foreign key constraint/,
  );

  await client.query(
    `
      UPDATE notifications
      SET status = 'read', read_at = '2026-01-01T00:09:30.000Z'
      WHERE id = $1
    `,
    [fixture.notification],
  );
  const notification = await client.query(
    "SELECT status, read_at IS NOT NULL AS has_read_at FROM notifications WHERE id = $1",
    [fixture.notification],
  );
  assert.deepEqual(notification.rows[0], {
    status: "read",
    has_read_at: true,
  });

  await assert.rejects(
    client.query(
      `
        INSERT INTO notifications (
          id,
          organization_id,
          recipient_user_id,
          category,
          title,
          body,
          payload,
          status
        )
        VALUES (
          '10000000-0000-4000-8000-000000001191',
          $1,
          $2,
          'info',
          'Broken notification',
          'Missing read_at',
          '{}'::jsonb,
          'read'
        )
      `,
      [ORG_A, fixture.user],
    ),
    /notifications_read_at_consistency_check|violates check constraint/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO notification_settings (
          id,
          organization_id,
          user_id,
          category,
          channel,
          enabled
        )
        VALUES (
          '10000000-0000-4000-8000-000000001192',
          $1,
          $2,
          'warning',
          'web',
          false
        )
      `,
      [ORG_A, fixture.user],
    ),
    /notification_settings_user_category_channel_unique|duplicate key value/,
  );
}

async function assertM5Invariants(client) {
  const fixture = M1_FIXTURES[ORG_A];

  await client.query("DELETE FROM configurations WHERE id = $1", [fixture.config]);
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
    history.rows.map((row) => [row.version, row.value.mode, row.value.deleted === true]),
    [
      [1, "manual", false],
      [2, "auto", false],
      [3, "auto", true],
    ],
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO configurations (id, organization_id, key, value, version, updated_by)
        VALUES ('10000000-0000-4000-8000-000000000998', $1, 'core.routing', '{"mode":"reset"}'::jsonb, 1, $2)
      `,
      [ORG_A, fixture.user],
    ),
    /configuration_history_organization_key_version_unique|duplicate key value/,
  );

  await assert.rejects(
    client.query(
      "SELECT * FROM app.anonymize_client_personal_data($1, $2, $3, $4, $5)",
      [ORG_A, fixture.client, fixture.user, "request-with-pii", "bad reason with raw text"],
    ),
    /reason_code/,
  );
  await assert.rejects(
    client.query(
      "SELECT * FROM app.anonymize_client_personal_data($1, $2, $3, $4, $5)",
      [ORG_A, fixture.client, fixture.user, "alice@example.bridge.local", "subject_erasure_request"],
    ),
    /request_id/,
  );

  const anonymized = await client.query(
    "SELECT * FROM app.anonymize_client_personal_data($1, $2, $3, $4, $5)",
    [ORG_A, fixture.client, fixture.user, "request-m5-anonymize-a", "subject_erasure_request"],
  );
  assert.equal(anonymized.rowCount, 1);
  assert.equal(anonymized.rows[0].client_id, fixture.client);
  assert.equal(anonymized.rows[0].endpoints, 1);
  assert.equal(anonymized.rows[0].identity_links, 2);
  assert.equal(anonymized.rows[0].messages, 3);
  assert.equal(anonymized.rows[0].attachments, 1);
  assert.equal(anonymized.rows[0].delivery_attempts, 1);
  assert.equal(anonymized.rows[0].notes, 1);
  assert.equal(anonymized.rows[0].tags, 1);

  const clientRow = await client.query(
    "SELECT display_name, anonymized_at IS NOT NULL AS anonymized FROM clients WHERE id = $1",
    [fixture.client],
  );
  assert.deepEqual(clientRow.rows[0], {
    display_name: null,
    anonymized: true,
  });

  const endpoints = await client.query(
    `
      SELECT external_id, verified, verified_at, metadata
      FROM communication_endpoints
      WHERE client_id = $1
    `,
    [fixture.client],
  );
  assert.equal(endpoints.rows[0].external_id.startsWith("anonymous:"), true);
  assert.equal(endpoints.rows[0].verified, false);
  assert.equal(endpoints.rows[0].verified_at, null);
  assert.equal(endpoints.rows[0].metadata.anonymized, true);

  const messages = await client.query(
    `
      SELECT content
      FROM messages
      WHERE organization_id = $1 AND conversation_id = $2
      ORDER BY sequence_number
    `,
    [ORG_A, fixture.conversation],
  );
  assert.deepEqual(
    messages.rows.map((row) => row.content),
    [
      { anonymized: true },
      { anonymized: true },
      { anonymized: true },
    ],
  );

  const attachment = await client.query(
    "SELECT storage_ref, metadata FROM attachments WHERE id = $1",
    [fixture.attachment],
  );
  assert.equal(attachment.rows[0].storage_ref.startsWith("anonymized://attachment/"), true);
  assert.equal(attachment.rows[0].metadata.anonymized, true);

  const deliveryAttempt = await client.query(
    "SELECT error FROM message_delivery_attempts WHERE id = $1",
    [fixture.attempt],
  );
  assert.equal(deliveryAttempt.rows[0].error, null);

  const notes = await client.query("SELECT body FROM client_notes WHERE id = $1", [
    fixture.clientNote,
  ]);
  assert.equal(notes.rows[0].body, "[anonymized]");

  const tags = await client.query("SELECT tag FROM client_tags WHERE id = $1", [
    fixture.clientTag,
  ]);
  assert.equal(tags.rows[0].tag.startsWith("anonymized:"), true);

  const identityLinks = await client.query(
    `
      SELECT evidence, reverted_reason
      FROM client_identity_links
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY created_at
    `,
    [ORG_A, fixture.client],
  );
  assert.deepEqual(
    identityLinks.rows.map((row) => [row.evidence, row.reverted_reason]),
    [
      [{ anonymized: true }, "anonymized"],
      [{ anonymized: true }, null],
    ],
  );

  const audit = await client.query(
    `
      SELECT actor_user_id, actor_type, action, object_type, object_id, result, request_id, metadata
      FROM audit_events
      WHERE id = $1
    `,
    [anonymized.rows[0].audit_event_id],
  );
  assert.deepEqual(audit.rows[0], {
    actor_user_id: fixture.user,
    actor_type: "user",
    action: "client.anonymized",
    object_type: "client",
    object_id: fixture.client,
    result: "success",
    request_id: "request-m5-anonymize-a",
    metadata: {
      attachments: 1,
      client_id: fixture.client,
      delivery_attempts: 1,
      endpoints: 1,
      identity_links: 2,
      messages: 3,
      notes: 1,
      reason_code: "subject_erasure_request",
      tags: 1,
    },
  });

  const orgBClient = await client.query("SELECT display_name FROM clients WHERE id = $1", [
    M1_FIXTURES[ORG_B].client,
  ]);
  assert.match(orgBClient.rows[0].display_name, /Bob Example/);

  const snapshot = JSON.stringify({
    client: clientRow.rows,
    endpoints: endpoints.rows,
    messages: messages.rows,
    attachment: attachment.rows,
    deliveryAttempt: deliveryAttempt.rows,
    notes: notes.rows,
    tags: tags.rows,
    identityLinks: identityLinks.rows,
    audit: audit.rows,
  });
  for (const token of [
    "Alice Example",
    "alice@example.bridge.local",
    "+79000000001",
    "passport-a.png",
    "segment-a-alice-example",
    "web-chat-a:alice",
  ]) {
    assert.equal(snapshot.includes(token), false, `${token} must be erased`);
  }
}

async function runDockerExec(container, args) {
  return execFileAsync("docker", [
    "exec",
    "-e",
    `PGPASSWORD=${TEST_DB.password}`,
    container.getId(),
    ...args,
  ]);
}

async function recreateDatabase(container, databaseName) {
  await withClient(connectionConfig(container, { database: "postgres" }), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(TEST_DB.user)}`,
    );
  });
}

async function dropDatabase(container, databaseName) {
  await withClient(connectionConfig(container, { database: "postgres" }), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  });
}

async function readCriticalDataCounts(client) {
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM organizations) AS organizations,
      (SELECT count(*)::int FROM clients) AS clients,
      (SELECT count(*)::int FROM communication_endpoints) AS communication_endpoints,
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM configuration_history) AS configuration_history,
      (SELECT count(*)::int FROM audit_events) AS audit_events,
      (SELECT count(*)::int FROM outbox_events) AS outbox_events
  `);

  return counts.rows[0];
}

async function assertApplicationBackupRestore(container, sourceClient) {
  const expectedCounts = await readCriticalDataCounts(sourceClient);

  await recreateDatabase(container, RESTORE_DB);
  try {
    const backupStartedAt = performance.now();
    await runDockerExec(container, [
      "pg_dump",
      "-U",
      TEST_DB.user,
      "-d",
      TEST_DB.database,
      "--format=custom",
      "--file",
      APP_BACKUP_FILE,
      "--no-owner",
      "--no-privileges",
    ]);
    const backupMs = performance.now() - backupStartedAt;

    const restoreStartedAt = performance.now();
    await runDockerExec(container, [
      "pg_restore",
      "-U",
      TEST_DB.user,
      "-d",
      RESTORE_DB,
      "--no-owner",
      "--no-privileges",
      APP_BACKUP_FILE,
    ]);
    const restoreMs = performance.now() - restoreStartedAt;

    await withClient(connectionConfig(container, { database: RESTORE_DB }), async (restoreClient) => {
      await assertDataPlatformSchema(restoreClient, { expectSeedData: true });
      assert.deepEqual(await readCriticalDataCounts(restoreClient), expectedCounts);

      const restoredClient = await restoreClient.query(
        "SELECT display_name, anonymized_at IS NOT NULL AS anonymized FROM clients WHERE id = $1",
        [M1_FIXTURES[ORG_A].client],
      );
      assert.deepEqual(restoredClient.rows[0], {
        display_name: null,
        anonymized: true,
      });
    });

    assert.ok(backupMs + restoreMs < 300_000);
    console.log(
      JSON.stringify({
        target: "app",
        backupSeconds: Number((backupMs / 1000).toFixed(3)),
        restoreSeconds: Number((restoreMs / 1000).toFixed(3)),
      }),
    );
  } finally {
    await runDockerExec(container, ["rm", "-f", APP_BACKUP_FILE]).catch(() => {});
    await dropDatabase(container, RESTORE_DB);
  }
}

async function readRfDataCounts(client) {
  const counts = await client.query(`
    SELECT
      count(*)::int AS buffered_messages,
      count(*) FILTER (WHERE forwarded_at IS NULL)::int AS pending_messages,
      count(*) FILTER (WHERE forwarded_at IS NOT NULL)::int AS forwarded_messages
    FROM edge_message_buffer
  `);

  return counts.rows[0];
}

async function assertRfBackupRestore(container, sourceClient) {
  const expectedCounts = await readRfDataCounts(sourceClient);

  await recreateDatabase(container, RESTORE_DB);
  try {
    const backupStartedAt = performance.now();
    await runDockerExec(container, [
      "pg_dump",
      "-U",
      TEST_DB.user,
      "-d",
      TEST_DB.database,
      "--format=custom",
      "--file",
      RF_BACKUP_FILE,
      "--no-owner",
      "--no-privileges",
    ]);
    const backupMs = performance.now() - backupStartedAt;

    const restoreStartedAt = performance.now();
    await runDockerExec(container, [
      "pg_restore",
      "-U",
      TEST_DB.user,
      "-d",
      RESTORE_DB,
      "--no-owner",
      "--no-privileges",
      RF_BACKUP_FILE,
    ]);
    const restoreMs = performance.now() - restoreStartedAt;

    await withClient(connectionConfig(container, { database: RESTORE_DB }), async (restoreClient) => {
      await assertEdgeRfSchema(restoreClient);
      assert.deepEqual(await readRfDataCounts(restoreClient), expectedCounts);
    });

    assert.ok(backupMs + restoreMs < 300_000);
    console.log(
      JSON.stringify({
        target: "rf",
        backupSeconds: Number((backupMs / 1000).toFixed(3)),
        restoreSeconds: Number((restoreMs / 1000).toFixed(3)),
      }),
    );
  } finally {
    await runDockerExec(container, ["rm", "-f", RF_BACKUP_FILE]).catch(() => {});
    await dropDatabase(container, RESTORE_DB);
  }
}

async function assertWorkflowExecutionLogIsolation(adminConfig, adminClient) {
  const roleName = `wf_log_probe_${process.pid}`;
  const roleIdentifier = quoteIdentifier(roleName);

  await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  await adminClient.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD 'bridge_test'`);
  await adminClient.query(`GRANT USAGE ON SCHEMA app, public TO ${roleIdentifier}`);
  await adminClient.query(`GRANT SELECT ON workflow_execution_logs TO ${roleIdentifier}`);

  try {
    await withClient(connectionConfigFromAdmin(adminConfig, { user: roleName }), async (client) => {
      // Без контекста арендатора журналы исполнения не видны.
      let result = await client.query(
        "SELECT count(*)::int AS count FROM workflow_execution_logs",
      );
      assert.equal(result.rows[0].count, 0);

      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        ORG_A,
      ]);
      result = await client.query(
        "SELECT id FROM workflow_execution_logs ORDER BY created_at",
      );
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [
          M1_FIXTURES[ORG_A].workflowLogStarted,
          M1_FIXTURES[ORG_A].workflowLogFinished,
        ],
      );

      await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
        ORG_B,
      ]);
      result = await client.query(
        "SELECT id FROM workflow_execution_logs ORDER BY created_at",
      );
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [
          M1_FIXTURES[ORG_B].workflowLogStarted,
          M1_FIXTURES[ORG_B].workflowLogFinished,
        ],
      );
    });
  } finally {
    await adminClient.query(`DROP OWNED BY ${roleIdentifier}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  }
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

async function assertEdgeRfSchema(client) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      ORDER BY table_name
    `,
    [EDGE_RF_TABLES],
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    EDGE_RF_TABLES,
  );

  const columns = await client.query(
    `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'edge_message_buffer'
      ORDER BY column_name
    `,
  );
  assert.deepEqual(
    columns.rows.map((row) => [row.column_name, row.is_nullable]),
    [
      ["endpoint_id", "NO"],
      ["forwarded_at", "YES"],
      ["id", "NO"],
      ["idempotency_key", "NO"],
      ["payload_encrypted", "NO"],
      ["received_at", "NO"],
      ["sequence_number", "NO"],
      ["ttl", "NO"],
    ],
  );

  const indexes = await client.query(
    `
      SELECT to_regclass('public.edge_message_buffer_idempotency_key_unique') AS idempotency_key_unique,
             to_regclass('public.edge_message_buffer_endpoint_sequence_unique') AS endpoint_sequence_unique,
             to_regclass('public.edge_message_buffer_pending_drain_idx') AS pending_drain_idx,
             to_regclass('public.edge_message_buffer_ttl_idx') AS ttl_idx
    `,
  );
  assert.deepEqual(indexes.rows[0], {
    idempotency_key_unique: "edge_message_buffer_idempotency_key_unique",
    endpoint_sequence_unique: "edge_message_buffer_endpoint_sequence_unique",
    pending_drain_idx: "edge_message_buffer_pending_drain_idx",
    ttl_idx: "edge_message_buffer_ttl_idx",
  });
}

async function assertEdgeRfSchemaDropped(client) {
  const objects = await client.query(`
    SELECT to_regclass('public.edge_message_buffer') AS edge_message_buffer
  `);
  assert.deepEqual(objects.rows[0], {
    edge_message_buffer: null,
  });
}

async function assertEdgeMessageBufferInvariants(client) {
  await client.query(
    `
      INSERT INTO edge_message_buffer (
        id,
        endpoint_id,
        sequence_number,
        idempotency_key,
        payload_encrypted,
        received_at,
        ttl
      )
      VALUES
        ($1, $2, 1, $3, $4, '2026-01-01T00:00:01.000Z', '2026-01-01T01:00:01.000Z'),
        ($5, $2, 2, $6, $7, '2026-01-01T00:00:02.000Z', '2026-01-01T01:00:02.000Z')
    `,
    [
      EDGE_FIXTURES.first,
      EDGE_FIXTURES.endpoint,
      EDGE_FIXTURES.firstIdempotencyKey,
      Buffer.from("encrypted-edge-payload-1"),
      EDGE_FIXTURES.second,
      EDGE_FIXTURES.secondIdempotencyKey,
      Buffer.from("encrypted-edge-payload-2"),
    ],
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO edge_message_buffer (
          id,
          endpoint_id,
          sequence_number,
          idempotency_key,
          payload_encrypted,
          received_at,
          ttl
        )
        VALUES ($1, $2, 3, $3, $4, '2026-01-01T00:00:03.000Z', '2026-01-01T01:00:03.000Z')
      `,
      [
        EDGE_FIXTURES.duplicate,
        EDGE_FIXTURES.endpoint,
        EDGE_FIXTURES.firstIdempotencyKey,
        Buffer.from("duplicate-idempotency-key"),
      ],
    ),
    /edge_message_buffer_idempotency_key_unique|duplicate key value/,
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO edge_message_buffer (
          id,
          endpoint_id,
          sequence_number,
          idempotency_key,
          payload_encrypted,
          received_at,
          ttl
        )
        VALUES (
          '20000000-0000-4000-8000-000000000504',
          $1,
          2,
          '20000000-0000-4000-8000-000000000604',
          $2,
          '2026-01-01T00:00:04.000Z',
          '2026-01-01T01:00:04.000Z'
        )
      `,
      [EDGE_FIXTURES.endpoint, Buffer.from("duplicate-sequence")],
    ),
    /edge_message_buffer_endpoint_sequence_unique|duplicate key value/,
  );

  const pending = await client.query(
    `
      SELECT id
      FROM edge_message_buffer
      WHERE forwarded_at IS NULL
      ORDER BY endpoint_id, sequence_number
    `,
  );
  assert.deepEqual(
    pending.rows.map((row) => row.id),
    [EDGE_FIXTURES.first, EDGE_FIXTURES.second],
  );

  await client.query(
    `
      UPDATE edge_message_buffer
      SET forwarded_at = '2026-01-01T00:01:00.000Z'
      WHERE id = $1
    `,
    [EDGE_FIXTURES.first],
  );
  const remaining = await client.query(
    `
      SELECT id
      FROM edge_message_buffer
      WHERE forwarded_at IS NULL
      ORDER BY endpoint_id, sequence_number
    `,
  );
  assert.deepEqual(
    remaining.rows.map((row) => row.id),
    [EDGE_FIXTURES.second],
  );

  await assert.rejects(
    client.query(
      `
        INSERT INTO edge_message_buffer (
          id,
          endpoint_id,
          sequence_number,
          idempotency_key,
          payload_encrypted,
          received_at,
          ttl
        )
        VALUES (
          '20000000-0000-4000-8000-000000000505',
          $1,
          5,
          '20000000-0000-4000-8000-000000000605',
          $2,
          '2026-01-01T01:00:00.000Z',
          '2026-01-01T00:59:59.000Z'
        )
      `,
      [EDGE_FIXTURES.endpoint, Buffer.from("expired-before-received")],
    ),
    /edge_message_buffer_ttl_after_received_check|violates check constraint/,
  );
}

describe("SVC-DATA M5 migrations", { timeout: 300_000 }, () => {
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
        await runSeeds({ client });
        await assertDataPlatformSchema(client, { expectSeedData: true });
        await insertM1TenantSlice(client, ORG_A);
        await insertM1TenantSlice(client, ORG_B);
        await assertM1Invariants(client);
        await assertM2Invariants(client);
        await assertRlsIsolation(adminConfig, client);
        await assertKnowledgeVectorSearchIsolation(adminConfig, client);
        await assertWorkflowExecutionLogIsolation(adminConfig, client);
        await assertM3Invariants(client);
        await assertM4Invariants(client);
        await assertM5Invariants(client);
        await assertApplicationBackupRestore(container, client);

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

  it("runs RF edge buffer migrations up, down, and up again on a separate database", async () => {
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
        await runMigrations({ databaseUrl: adminConfig, direction: "up", target: "rf" });
        await assertEdgeRfSchema(client);
        await assertEdgeMessageBufferInvariants(client);
        await assertRfBackupRestore(container, client);

        await runMigrations({
          databaseUrl: adminConfig,
          direction: "down",
          count: Number.POSITIVE_INFINITY,
          target: "rf",
        });
        await assertEdgeRfSchemaDropped(client);

        await runMigrations({ databaseUrl: adminConfig, direction: "up", target: "rf" });
        await assertEdgeRfSchema(client);
      });
    } finally {
      await container.stop();
    }
  });
});
