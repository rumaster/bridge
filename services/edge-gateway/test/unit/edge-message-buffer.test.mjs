import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EdgeMessageBufferBackpressureError,
  EdgeMessageBufferError,
  createInMemoryEdgeMessageBufferStore,
} from "../../src/edge-message-buffer.mjs";

const ENDPOINT_A = "42345678-1234-4234-8234-1234567890a1";
const ENDPOINT_B = "42345678-1234-4234-8234-1234567890b2";
const BASE = "2026-07-04T10:00:00.000Z";
const HOUR_LATER = "2026-07-04T11:00:00.000Z";
const TWO_HOURS_LATER = "2026-07-04T12:00:00.000Z";

function entry(overrides = {}) {
  return {
    endpoint_id: ENDPOINT_A,
    sequence_number: 1,
    idempotency_key: "msg-1",
    payload_encrypted: Buffer.from("шифртекст-1"),
    received_at: BASE,
    ttl: HOUR_LATER,
    forwarded_at: null,
    ...overrides,
  };
}

describe("Edge message buffer store (RF-буфер §7.9/§7.14, CP-7)", () => {
  it("записывает сообщение и хранит зашифрованный payload как Buffer", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    const result = await store.enqueue(entry());

    assert.equal(result.inserted, true);
    assert.equal(result.duplicate, false);
    assert.ok(Buffer.isBuffer(result.record.payload_encrypted));
    assert.equal(result.record.payload_encrypted.toString("utf8"), "шифртекст-1");
    assert.ok(result.record.id, "id генерируется, если не задан");
    assert.equal(result.record.forwarded_at, null);
    assert.equal(await store.size(), 1);
  });

  it("дедуплицирует по idempotency_key (end-to-end, §11.12): повтор не создаёт запись", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    const first = await store.enqueue(entry());
    const second = await store.enqueue(
      entry({ sequence_number: 2, payload_encrypted: Buffer.from("повтор") }),
    );

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.duplicate, true);
    // Возвращается уже сохранённая запись, повтор не перезаписывает payload/seq.
    assert.equal(second.record.sequence_number, 1);
    assert.equal(second.record.payload_encrypted.toString("utf8"), "шифртекст-1");
    assert.equal(await store.size(), 1);
    assert.equal(store.getMetrics().duplicate_total, 1);
  });

  it("отклоняет коллизию (endpoint_id, sequence_number) при разных idempotency_key", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    await store.enqueue(entry({ idempotency_key: "msg-a", sequence_number: 5 }));

    await assert.rejects(
      () => store.enqueue(entry({ idempotency_key: "msg-b", sequence_number: 5 })),
      EdgeMessageBufferError,
    );
  });

  it("listPendingDrain возвращает не отправленные записи в порядке (endpoint_id, sequence_number)", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    // Кладём вперемешку и по двум endpoint.
    await store.enqueue(entry({ endpoint_id: ENDPOINT_B, sequence_number: 2, idempotency_key: "b-2" }));
    await store.enqueue(entry({ endpoint_id: ENDPOINT_A, sequence_number: 3, idempotency_key: "a-3" }));
    await store.enqueue(entry({ endpoint_id: ENDPOINT_A, sequence_number: 1, idempotency_key: "a-1" }));
    await store.enqueue(entry({ endpoint_id: ENDPOINT_B, sequence_number: 1, idempotency_key: "b-1" }));
    await store.enqueue(entry({ endpoint_id: ENDPOINT_A, sequence_number: 2, idempotency_key: "a-2" }));

    const pending = await store.listPendingDrain({ now: BASE });

    assert.deepEqual(
      pending.map((r) => `${r.endpoint_id === ENDPOINT_A ? "A" : "B"}${r.sequence_number}`),
      ["A1", "A2", "A3", "B1", "B2"],
    );
  });

  it("markForwarded исключает запись из дренажа и не удаляет её из буфера", async () => {
    const store = createInMemoryEdgeMessageBufferStore();
    await store.enqueue(entry({ idempotency_key: "msg-1", sequence_number: 1 }));
    await store.enqueue(entry({ idempotency_key: "msg-2", sequence_number: 2 }));

    const marked = await store.markForwarded("msg-1", HOUR_LATER);

    assert.equal(marked.forwarded_at, HOUR_LATER);
    const pending = await store.listPendingDrain({ now: BASE });
    assert.deepEqual(pending.map((r) => r.idempotency_key), ["msg-2"]);
    // Запись остаётся в буфере до явной очистки (инвариант «без потерь»).
    assert.equal(await store.size(), 2);
    assert.equal(store.getMetrics().forwarded_total, 1);
  });

  it("не дренажирует просроченные по ttl записи; listExpired их выделяет", async () => {
    const store = createInMemoryEdgeMessageBufferStore();
    await store.enqueue(entry({ idempotency_key: "fresh", sequence_number: 1, ttl: TWO_HOURS_LATER }));
    await store.enqueue(entry({ idempotency_key: "stale", sequence_number: 2, ttl: HOUR_LATER }));

    // now между ttl «stale» и ttl «fresh».
    const now = "2026-07-04T11:30:00.000Z";
    const pending = await store.listPendingDrain({ now });
    const expired = await store.listExpired({ now });

    assert.deepEqual(pending.map((r) => r.idempotency_key), ["fresh"]);
    assert.deepEqual(expired.map((r) => r.idempotency_key), ["stale"]);
  });

  it("при исчерпании ёмкости сигнализирует backpressure и не подтверждает новую фиксацию", async () => {
    const notifications = [];
    const store = createInMemoryEdgeMessageBufferStore({
      capacity: 2,
      highWatermarkRatio: 0.5,
      notify: (event) => notifications.push(event),
    });

    await store.enqueue(entry({ idempotency_key: "msg-1", sequence_number: 1 }));
    await store.enqueue(entry({ idempotency_key: "msg-2", sequence_number: 2 }));

    await assert.rejects(
      () => store.enqueue(entry({ idempotency_key: "msg-3", sequence_number: 3 })),
      EdgeMessageBufferBackpressureError,
    );

    assert.equal(await store.size(), 2, "переполненная запись не фиксируется в RF-буфере");
    assert.equal(store.getMetrics().capacity_rejected_total, 1);
    assert.equal(store.getMetrics().backpressure_total, 1);
    assert.ok(
      notifications.some((event) => event.type === "edge_buffer_capacity_high_watermark"),
      "достижение high-watermark должно быть заметно мониторингу",
    );
    assert.ok(
      notifications.some((event) => event.type === "edge_buffer_capacity_exhausted"),
      "исчерпание ёмкости должно быть заметно мониторингу",
    );
  });

  it("оповещает мониторинг о просроченных TTL записях как о RPO-границе буфера", async () => {
    const notifications = [];
    const store = createInMemoryEdgeMessageBufferStore({
      notify: (event) => notifications.push(event),
    });
    await store.enqueue(entry({ idempotency_key: "fresh", sequence_number: 1, ttl: TWO_HOURS_LATER }));
    await store.enqueue(entry({ idempotency_key: "stale", sequence_number: 2, ttl: HOUR_LATER }));

    const expired = await store.listExpired({ now: "2026-07-04T11:30:00.000Z" });

    assert.deepEqual(expired.map((r) => r.idempotency_key), ["stale"]);
    assert.equal(store.getMetrics().expired_total, 1);
    assert.deepEqual(
      notifications.find((event) => event.type === "edge_buffer_ttl_expired")?.idempotency_keys,
      ["stale"],
    );
  });

  it("purgeForwarded удаляет только подтверждённые записи и освобождает (endpoint,seq)", async () => {
    const store = createInMemoryEdgeMessageBufferStore();
    await store.enqueue(entry({ idempotency_key: "msg-1", sequence_number: 1 }));
    await store.enqueue(entry({ idempotency_key: "msg-2", sequence_number: 2 }));
    await store.markForwarded("msg-1", HOUR_LATER);

    const removed = await store.purgeForwarded();

    assert.equal(removed, 1);
    assert.equal(await store.size(), 1);
    // Слот (endpoint, seq=1) освобождён — можно записать новое сообщение с тем же seq.
    const reused = await store.enqueue(entry({ idempotency_key: "msg-3", sequence_number: 1 }));
    assert.equal(reused.inserted, true);
  });

  it("валидирует инварианты записи (seq>0, непустой payload, ttl>=received_at)", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    await assert.rejects(() => store.enqueue(entry({ sequence_number: 0 })), EdgeMessageBufferError);
    await assert.rejects(
      () => store.enqueue(entry({ payload_encrypted: Buffer.alloc(0) })),
      EdgeMessageBufferError,
    );
    await assert.rejects(
      () => store.enqueue(entry({ payload_encrypted: "не-буфер" })),
      EdgeMessageBufferError,
    );
    await assert.rejects(
      () => store.enqueue(entry({ ttl: "2026-07-04T09:00:00.000Z" })),
      EdgeMessageBufferError,
    );
  });

  it("markForwarded для несуществующего ключа возвращает null и не меняет метрики", async () => {
    const store = createInMemoryEdgeMessageBufferStore();

    const result = await store.markForwarded("нет-такого", HOUR_LATER);

    assert.equal(result, null);
    assert.equal(store.getMetrics().forwarded_total, 0);
  });
});
