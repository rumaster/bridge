import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.mjs";
import {
  EdgeMessageBufferError,
  createPostgresEdgeMessageBufferStore,
} from "../../services/edge-gateway/src/edge-message-buffer.mjs";
import { createRfPayloadCipher, RF_PAYLOAD_KEY_BYTES } from "../../services/edge-gateway/src/rf-payload-cipher.mjs";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_edge_rf",
  user: "bridge_edge_rf",
  password: "bridge_edge_rf",
};

const ENDPOINT_A = "30000000-0000-4000-8000-0000000006a1";
const ENDPOINT_B = "30000000-0000-4000-8000-0000000006b2";
const BASE = "2026-07-04T10:00:00.000Z";
const HOUR_LATER = "2026-07-04T11:00:00.000Z";
const TWO_HOURS_LATER = "2026-07-04T12:00:00.000Z";
// Детерминированный ключ (32 байта) — тестовая фикстура, не реальный секрет.
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 7);

let sequence = 0;
function uuid() {
  sequence += 1;
  const tail = String(sequence).padStart(12, "0");
  return `40000000-0000-4000-8000-${tail}`;
}

function connectionConfig(container) {
  return {
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    ...TEST_DB,
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

function entry(overrides = {}) {
  return {
    id: uuid(),
    endpoint_id: ENDPOINT_A,
    sequence_number: 1,
    idempotency_key: uuid(),
    payload_encrypted: Buffer.from("шифртекст-по-умолчанию"),
    received_at: BASE,
    ttl: HOUR_LATER,
    forwarded_at: null,
    ...overrides,
  };
}

describe("Edge message buffer Postgres store — RF-контур §7.9/§7.14 (CP-7)", () => {
  let container;
  let config;

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

    config = connectionConfig(container);
    await runMigrations({ databaseUrl: config, direction: "up", target: "rf" });
  });

  after(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("сохраняет зашифрованный payload и читает его обратно без потерь", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });
      const cipher = createRfPayloadCipher({ key: CIPHER_KEY });

      const canonical = { id: uuid(), content: { text: "секрет РФ" }, sequence_number: 1 };
      const idempotencyKey = uuid();
      const aad = { endpoint_id: ENDPOINT_A, sequence_number: 1, idempotency_key: idempotencyKey };
      const encrypted = cipher.encrypt(canonical, { aad });

      const result = await store.enqueue(
        entry({ idempotency_key: idempotencyKey, sequence_number: 1, payload_encrypted: encrypted }),
      );
      assert.equal(result.inserted, true);

      const stored = await store.get(idempotencyKey);
      assert.ok(Buffer.isBuffer(stored.payload_encrypted), "bytea читается как Buffer");
      // В таблице только шифртекст — расшифровать можно лишь ключом RF-контура.
      assert.equal(stored.payload_encrypted.includes(Buffer.from("секрет РФ", "utf8")), false);
      assert.deepEqual(cipher.decrypt(stored.payload_encrypted, { aad }), canonical);
    });
  });

  it("дедуплицирует по idempotency_key через ON CONFLICT DO NOTHING", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });
      const key = uuid();

      const first = await store.enqueue(
        entry({ idempotency_key: key, sequence_number: 10, payload_encrypted: Buffer.from("первый") }),
      );
      const second = await store.enqueue(
        entry({ idempotency_key: key, sequence_number: 11, payload_encrypted: Buffer.from("повтор") }),
      );

      assert.equal(first.inserted, true);
      assert.equal(second.inserted, false);
      assert.equal(second.duplicate, true);
      // Повтор не перезаписал уже зафиксированную запись.
      assert.equal(second.record.sequence_number, 10);
      assert.equal(second.record.payload_encrypted.toString("utf8"), "первый");
    });
  });

  it("отклоняет коллизию (endpoint_id, sequence_number) как EdgeMessageBufferError", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });

      await store.enqueue(entry({ endpoint_id: ENDPOINT_B, sequence_number: 100 }));
      await assert.rejects(
        () => store.enqueue(entry({ endpoint_id: ENDPOINT_B, sequence_number: 100 })),
        EdgeMessageBufferError,
      );
    });
  });

  it("listPendingDrain отдаёт не отправленные записи в порядке (endpoint_id, sequence_number)", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });
      const ep = uuid();

      await store.enqueue(entry({ endpoint_id: ep, sequence_number: 3 }));
      await store.enqueue(entry({ endpoint_id: ep, sequence_number: 1 }));
      await store.enqueue(entry({ endpoint_id: ep, sequence_number: 2 }));

      const pending = await store.listPendingDrain({ now: BASE });
      const forThisEndpoint = pending.filter((r) => r.endpoint_id === ep);
      assert.deepEqual(
        forThisEndpoint.map((r) => r.sequence_number),
        [1, 2, 3],
      );
    });
  });

  it("markForwarded исключает запись из дренажа, но сохраняет её в буфере", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });
      const ep = uuid();
      const drained = uuid();

      await store.enqueue(entry({ endpoint_id: ep, sequence_number: 1, idempotency_key: drained }));
      await store.enqueue(entry({ endpoint_id: ep, sequence_number: 2 }));

      const marked = await store.markForwarded(drained, HOUR_LATER);
      assert.equal(marked.forwarded_at, new Date(HOUR_LATER).toISOString());

      const pending = await store.listPendingDrain({ now: BASE });
      assert.equal(
        pending.some((r) => r.idempotency_key === drained),
        false,
      );
      // Запись физически осталась (инвариант «без потерь»).
      assert.ok(await store.get(drained));
    });
  });

  it("не дренажирует просроченные по ttl; purgeForwarded чистит только подтверждённые", async () => {
    await withClient(config, async (client) => {
      const store = createPostgresEdgeMessageBufferStore({ client });
      const ep = uuid();
      const stale = uuid();
      const fresh = uuid();
      const forwarded = uuid();

      await store.enqueue(
        entry({ endpoint_id: ep, sequence_number: 1, idempotency_key: stale, ttl: HOUR_LATER }),
      );
      await store.enqueue(
        entry({ endpoint_id: ep, sequence_number: 2, idempotency_key: fresh, ttl: TWO_HOURS_LATER }),
      );
      await store.enqueue(
        entry({ endpoint_id: ep, sequence_number: 3, idempotency_key: forwarded, ttl: TWO_HOURS_LATER }),
      );
      await store.markForwarded(forwarded, HOUR_LATER);

      const now = "2026-07-04T11:30:00.000Z";
      const pending = await store.listPendingDrain({ now });
      const expired = await store.listExpired({ now });

      assert.deepEqual(
        pending.filter((r) => r.endpoint_id === ep).map((r) => r.idempotency_key),
        [fresh],
      );
      assert.deepEqual(
        expired.filter((r) => r.endpoint_id === ep).map((r) => r.idempotency_key),
        [stale],
      );

      const removed = await store.purgeForwarded();
      assert.ok(removed >= 1);
      assert.equal(await store.get(forwarded), null);
      assert.ok(await store.get(stale), "просроченная, но не отправленная запись остаётся");
    });
  });
});
