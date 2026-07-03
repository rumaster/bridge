import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../../../scripts/db-migrate.mjs";
import { runSeeds } from "../../../../scripts/db-seed.mjs";
import {
  IDENTITY_AUDIT_ACTIONS,
  createIdentityService,
  createMockTelegramCodeDeliveryAdapter,
  createPostgresAuditRecorder,
  createPostgresIdentityStore,
} from "../../src/modules/identity/identity-service.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_identity_test",
  user: "bridge_identity_test",
  password: "bridge_identity_test",
};

function connectionConfig(container) {
  return {
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    ...TEST_DB,
  };
}

describe("identity M1 PostgreSQL integration", { timeout: 300_000 }, () => {
  let client;
  let container;
  let service;
  let tokenCounter = 0;

  before(async () => {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: TEST_DB.database,
        POSTGRES_USER: TEST_DB.user,
        POSTGRES_PASSWORD: TEST_DB.password,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    client = new pg.Client(connectionConfig(container));
    await client.connect();

    await runMigrations({ databaseUrl: connectionConfig(container), direction: "up" });
    await runSeeds({ client });

    service = createIdentityService({
      codeGenerator: () => "123456",
      deliveryAdapter: createMockTelegramCodeDeliveryAdapter(),
      hashSecret: "postgres-test-secret",
      now: () => new Date("2026-07-03T10:00:00.000Z"),
      auditRecorder: createPostgresAuditRecorder({ client }),
      store: createPostgresIdentityStore({ client }),
      tokenGenerator: () => `brs_postgres_test_token_${++tokenCounter}`,
    });
  });

  after(async () => {
    await client?.end();
    await container?.stop();
  });

  it("persists login_codes and auth_sessions with hashes only", async () => {
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });

    assert.equal(start.status, 202);

    const loginCodeRows = await client.query(
      "SELECT code_hash, consumed_at, attempt_count, locked_until FROM login_codes WHERE id = $1",
      [start.body.requestId],
    );

    assert.equal(loginCodeRows.rowCount, 1);
    assert.match(loginCodeRows.rows[0].code_hash, /^sha256:/);
    assert.notEqual(loginCodeRows.rows[0].code_hash, "123456");
    assert.equal(loginCodeRows.rows[0].consumed_at, null);
    assert.equal(loginCodeRows.rows[0].attempt_count, 0);
    assert.equal(loginCodeRows.rows[0].locked_until, null);

    const verify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });

    assert.equal(verify.status, 200);
    assert.equal(verify.body.token, "brs_postgres_test_token_1");

    const consumedRows = await client.query(
      "SELECT consumed_at FROM login_codes WHERE id = $1",
      [start.body.requestId],
    );
    assert.equal(
      consumedRows.rows[0].consumed_at.toISOString(),
      "2026-07-03T10:00:00.000Z",
    );

    const sessionRows = await client.query(
      "SELECT token_hash, revoked_at FROM auth_sessions WHERE id = $1",
      [verify.body.session.id],
    );
    assert.equal(sessionRows.rowCount, 1);
    assert.match(sessionRows.rows[0].token_hash, /^sha256:/);
    assert.notEqual(sessionRows.rows[0].token_hash, "brs_postgres_test_token_1");
    assert.equal(sessionRows.rows[0].revoked_at, null);

    const session = await service.getSessionByToken("brs_postgres_test_token_1");
    assert.equal(session.status, 200);
    assert.equal(session.body.organization.id, verify.body.organization.id);
  });

  it("revokes persisted sessions and rejects them after logout", async () => {
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });
    const verify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "123456",
    });
    const session = await service.getSessionByToken(verify.body.token);

    const logout = await service.logout(session.body);
    assert.equal(logout.status, 200);

    const revokedRows = await client.query(
      "SELECT revoked_at FROM auth_sessions WHERE id = $1",
      [verify.body.session.id],
    );
    assert.equal(
      revokedRows.rows[0].revoked_at.toISOString(),
      "2026-07-03T10:00:00.000Z",
    );

    const rejected = await service.getSessionByToken(verify.body.token);
    assert.equal(rejected.status, 401);
  });

  it("writes append-only audit_events for login failures, successful login, logout, and tenant isolation", async () => {
    const start = await service.startTelegramLogin({
      telegramUsername: "seeded_admin",
    });
    assert.equal(start.status, 202);

    const failedVerify = await service.verifyTelegramLogin({
      requestId: start.body.requestId,
      code: "000000",
    });
    assert.equal(failedVerify.status, 401);

    const verify = await service.verifyTelegramLogin(
      {
        requestId: start.body.requestId,
        code: "123456",
      },
      {
        ip: "127.0.0.1",
        userAgent: "identity-postgres-test",
      },
    );
    assert.equal(verify.status, 200);

    const session = await service.getSessionByToken(verify.body.token);
    const logout = await service.logout(session.body);
    assert.equal(logout.status, 200);

    const audit = await client.query(
      `
        SELECT action, actor_user_id, host(ip) AS ip, object_id, object_type, result, metadata
        FROM audit_events
        WHERE organization_id = $1
          AND (
            request_id = $2
            OR object_id = $3
          )
        ORDER BY action
      `,
      [verify.body.organization.id, start.body.requestId, verify.body.session.id],
    );

    assert.deepEqual(
      audit.rows.map((row) => [row.action, row.object_type, row.result]),
      [
        [IDENTITY_AUDIT_ACTIONS.loginFailure, "login_code", "failure"],
        [IDENTITY_AUDIT_ACTIONS.loginStart, "login_code", "success"],
        [IDENTITY_AUDIT_ACTIONS.loginSuccess, "auth_session", "success"],
        [IDENTITY_AUDIT_ACTIONS.sessionLogout, "auth_session", "success"],
      ],
    );

    const successAudit = audit.rows.find(
      (row) => row.action === IDENTITY_AUDIT_ACTIONS.loginSuccess,
    );
    assert.equal(successAudit.actor_user_id, verify.body.user.id);
    assert.equal(successAudit.ip, "127.0.0.1");
    assert.equal(successAudit.metadata.loginCodeId, start.body.requestId);
    assert.deepEqual(successAudit.metadata.roleCodes, ["administrator"]);

    await assert.rejects(
      () =>
        client.query("UPDATE audit_events SET result = 'failure' WHERE object_id = $1", [
          verify.body.session.id,
        ]),
      /append-only/,
    );
    await assert.rejects(
      () => client.query("DELETE FROM audit_events WHERE object_id = $1", [verify.body.session.id]),
      /append-only/,
    );

    await assertAuditTenantIsolation(connectionConfig(container), client, {
      organizationId: verify.body.organization.id,
      requestId: start.body.requestId,
    });
  });
});

async function assertAuditTenantIsolation(adminConfig, adminClient, { organizationId, requestId }) {
  const roleName = `identity_audit_probe_${process.pid}`;
  const roleIdentifier = quoteIdentifier(roleName);

  await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  await adminClient.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD 'bridge_test'`);
  await adminClient.query(`GRANT USAGE ON SCHEMA app, public TO ${roleIdentifier}`);
  await adminClient.query(`GRANT SELECT ON audit_events TO ${roleIdentifier}`);

  try {
    await withClient(
      connectionConfigFromAdmin(adminConfig, {
        password: "bridge_test",
        user: roleName,
      }),
      async (restrictedClient) => {
        let result = await restrictedClient.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1",
          [requestId],
        );
        assert.equal(result.rows[0].count, 0);

        await restrictedClient.query(
          "SELECT set_config('app.current_organization_id', $1, false)",
          [organizationId],
        );
        result = await restrictedClient.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1",
          [requestId],
        );
        assert.equal(result.rows[0].count, 3);

        await restrictedClient.query(
          "SELECT set_config('app.current_organization_id', $1, false)",
          ["10000000-0000-4000-8000-000000000999"],
        );
        result = await restrictedClient.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1",
          [requestId],
        );
        assert.equal(result.rows[0].count, 0);
      },
    );
  } finally {
    await adminClient.query(`DROP OWNED BY ${roleIdentifier}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
  }
}

async function withClient(config, callback) {
  const pgClient = new pg.Client(config);
  await pgClient.connect();

  try {
    return await callback(pgClient);
  } finally {
    await pgClient.end();
  }
}

function connectionConfigFromAdmin(adminConfig, overrides = {}) {
  return {
    database: adminConfig.database,
    host: adminConfig.host,
    password: TEST_DB.password,
    port: adminConfig.port,
    user: adminConfig.user,
    ...overrides,
  };
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError(`Unsafe SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}
