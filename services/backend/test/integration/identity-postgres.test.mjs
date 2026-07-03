import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../../../scripts/db-migrate.mjs";
import { runSeeds } from "../../../../scripts/db-seed.mjs";
import {
  createIdentityService,
  createMockTelegramCodeDeliveryAdapter,
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
});
