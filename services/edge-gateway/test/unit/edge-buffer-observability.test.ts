import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBufferCapacityNotifier,
  resolveBufferCapacityOptions,
} from "../../src/edge-buffer-observability.js";
import { createInMemoryEdgeMessageBufferStore } from "../../src/edge-message-buffer.js";

function collectingLogger() {
  const warnLog: any[] = [];
  const errorLog: any[] = [];
  return {
    warnLog,
    errorLog,
    warn: (message: string, meta?: unknown) => warnLog.push({ message, meta }),
    error: (message: string, meta?: unknown) => errorLog.push({ message, meta }),
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    endpoint_id: "42345678-1234-4234-8234-1234567890a1",
    sequence_number: 1,
    idempotency_key: "msg-1",
    payload_encrypted: Buffer.from("payload"),
    received_at: "2026-07-04T10:00:00.000Z",
    ttl: "2026-07-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveBufferCapacityOptions", () => {
  it("по умолчанию — без лимита (Infinity) и порог 0.8, чтобы не менять поведение стенда", () => {
    assert.deepEqual(resolveBufferCapacityOptions({}), {
      capacity: Number.POSITIVE_INFINITY,
      highWatermarkRatio: 0.8,
    });
  });

  it("читает боевые capacity/ratio из окружения", () => {
    assert.deepEqual(
      resolveBufferCapacityOptions({
        EDGE_BUFFER_CAPACITY: "5000",
        EDGE_BUFFER_HIGH_WATERMARK_RATIO: "0.9",
      }),
      { capacity: 5000, highWatermarkRatio: 0.9 },
    );
  });

  it("трактует 0/пустое/некорректное значение capacity как «без лимита» (не роняет рантайм)", () => {
    for (const raw of ["0", "", "  ", "-10", "abc", "3.5", "infinity"]) {
      assert.equal(
        resolveBufferCapacityOptions({ EDGE_BUFFER_CAPACITY: raw }).capacity,
        Number.POSITIVE_INFINITY,
        `capacity=${JSON.stringify(raw)} должно откатиться к Infinity`,
      );
    }
  });

  it("некорректный ratio откатывается к 0.8", () => {
    for (const raw of ["0", "-0.1", "1.5", "abc", ""]) {
      assert.equal(
        resolveBufferCapacityOptions({ EDGE_BUFFER_HIGH_WATERMARK_RATIO: raw }).highWatermarkRatio,
        0.8,
      );
    }
  });
});

describe("createBufferCapacityNotifier", () => {
  it("логирует high-watermark: warning → warn, critical → error", () => {
    const logger = collectingLogger();
    const notify = createBufferCapacityNotifier({ logger });

    notify({ type: "edge_buffer_capacity_high_watermark", severity: "warning", size: 8, capacity: 10 });
    notify({ type: "edge_buffer_capacity_high_watermark", severity: "critical", size: 10, capacity: 10 });

    assert.equal(logger.warnLog.length, 1);
    assert.equal(logger.errorLog.length, 1);
    assert.match(logger.warnLog[0].message, /high-watermark/);
    assert.equal(logger.warnLog[0].meta.size, 8);
  });

  it("логирует исчерпание ёмкости как error с координатами записи", () => {
    const logger = collectingLogger();
    const notify = createBufferCapacityNotifier({ logger });

    notify({
      type: "edge_buffer_capacity_exhausted",
      severity: "critical",
      endpoint_id: "ep-1",
      sequence_number: 3,
      idempotency_key: "msg-3",
      size: 10,
      capacity: 10,
    });

    assert.equal(logger.errorLog.length, 1);
    assert.match(logger.errorLog[0].message, /исчерпана/);
    assert.equal(logger.errorLog[0].meta.idempotency_key, "msg-3");
  });

  it("игнорирует TTL-события (их с дедупом разбирает edge-cluster) и мусорный ввод", () => {
    const logger = collectingLogger();
    const notify = createBufferCapacityNotifier({ logger });

    notify({ type: "edge_buffer_ttl_expired", expired_count: 5 });
    notify(null);
    notify(undefined);
    notify("nonsense");

    assert.equal(logger.warnLog.length, 0);
    assert.equal(logger.errorLog.length, 0);
  });

  it("проводит capacity-события реального стора в лог (end-to-end с buffer store)", async () => {
    const logger = collectingLogger();
    const store = createInMemoryEdgeMessageBufferStore({
      capacity: 2,
      highWatermarkRatio: 0.5,
      notify: createBufferCapacityNotifier({ logger }),
    });

    await store.enqueue(entry({ idempotency_key: "msg-1", sequence_number: 1 }));
    await store.enqueue(entry({ idempotency_key: "msg-2", sequence_number: 2 }));
    await assert.rejects(() =>
      store.enqueue(entry({ idempotency_key: "msg-3", sequence_number: 3 })),
    );

    // high-watermark (size≥1) на warn + critical-watermark на error при size≥capacity,
    // исчерпание — на error. Достаточно убедиться, что оба канала получили сигнал.
    assert.ok(logger.warnLog.length + logger.errorLog.length >= 2);
    assert.ok(logger.errorLog.some((e) => /исчерпана/.test(e.message)));
  });
});
