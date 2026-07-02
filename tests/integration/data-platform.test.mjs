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

async function assertM0Schema(client, { expectSeedData }) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      ORDER BY table_name
    `,
    [["organizations", "roles", "users"]],
  );

  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ["organizations", "roles", "users"],
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
    [["organizations", "users"]],
  );

  assert.deepEqual(
    rls.rows.map((row) => [
      row.relname,
      row.relrowsecurity,
      row.relforcerowsecurity,
    ]),
    [
      ["organizations", true, true],
      ["users", true, true],
    ],
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

async function assertM0SchemaDropped(client) {
  const objects = await client.query(`
    SELECT
      to_regclass('public.organizations') AS organizations,
      to_regclass('public.roles') AS roles,
      to_regclass('public.users') AS users,
      to_regprocedure('app.current_organization_id()') AS current_organization_id,
      to_regprocedure('app.is_platform_operator()') AS is_platform_operator
  `);

  assert.deepEqual(objects.rows[0], {
    organizations: null,
    roles: null,
    users: null,
    current_organization_id: null,
    is_platform_operator: null,
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
  await adminClient.query(`GRANT SELECT ON organizations, users, roles TO ${roleIdentifier}`);

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

      await client.query(
        "SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000999', false)",
      );
      result = await client.query("SELECT count(*)::int AS count FROM users");
      assert.equal(result.rows[0].count, 0);

      await client.query("SELECT set_config('app.current_organization_id', '', false)");
      await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
      result = await client.query("SELECT count(*)::int AS count FROM users");
      assert.equal(result.rows[0].count, 1);
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

describe("SVC-DATA M0 migrations", { timeout: 300_000 }, () => {
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
        await assertM0Schema(client, { expectSeedData: true });
        await assertRlsIsolation(adminConfig, client);

        await runMigrations({
          databaseUrl: adminConfig,
          direction: "down",
          count: Number.POSITIVE_INFINITY,
        });
        await assertM0SchemaDropped(client);

        await runMigrations({ databaseUrl: adminConfig, direction: "up" });
        await assertM0Schema(client, { expectSeedData: false });
      });
    } finally {
      await container.stop();
    }
  });
});
