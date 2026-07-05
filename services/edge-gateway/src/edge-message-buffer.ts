import { randomUUID } from "node:crypto";

/**
 * Хранилище RF-буфера Edge — отражение таблицы `edge_message_buffer`
 * (ТЗ §7.9, §7.14, CP-7).
 *
 * При недоступности канала Edge продолжает приём и складывает зашифрованные
 * сообщения в буфер RF-контура (первичная фиксация ПДн субъектов РФ до вторичной
 * репликации за рубеж — RF-first). После восстановления канала буфер
 * автоматически дренажируется в Communication Core (C9), без потерь.
 *
 * Контракт стора (одинаков для in-memory и Postgres реализаций):
 *   enqueue(record)            — записать (дедуп по idempotency_key; уникальность
 *                                (endpoint_id, sequence_number));
 *   listPendingDrain({ now })  — не отправленные и не просроченные, по порядку
 *                                (endpoint_id, sequence_number, received_at);
 *   markForwarded(key, at)     — подтвердить пересылку (forwarded_at);
 *   listExpired({ now })       — просроченные (ttl < now) и ещё не отправленные;
 *   purgeForwarded()           — удалить уже подтверждённые (forwarded_at NOT NULL);
 *   getMetrics();
 *   getCapacityPolicy()        — лимит/порог для RPO и backpressure (M5).
 *
 * Инварианты (мастер §4.10): sequence_number > 0; payload_encrypted не пуст;
 * ttl >= received_at; запись НЕ удаляется, пока не подтверждён forwarded_at.
 */
export class EdgeMessageBufferError extends Error {
  constructor(message) {
    super(message);
    this.name = "EdgeMessageBufferError";
  }
}

export class EdgeMessageBufferBackpressureError extends EdgeMessageBufferError {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EdgeMessageBufferBackpressureError";
    this.details = details;
  }
}

export interface EdgeMessageBufferCapacityOptions {
  capacity?: number;
  highWatermarkRatio?: number;
  notify?: (event: any) => any;
}

function normalizeCapacityPolicy({
  capacity = Number.POSITIVE_INFINITY,
  highWatermarkRatio = 0.8,
  notify,
}: EdgeMessageBufferCapacityOptions = {}) {
  if (
    capacity !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(capacity) || capacity <= 0)
  ) {
    throw new EdgeMessageBufferError("capacity должен быть положительным целым или Infinity");
  }
  if (typeof highWatermarkRatio !== "number" || highWatermarkRatio <= 0 || highWatermarkRatio > 1) {
    throw new EdgeMessageBufferError("highWatermarkRatio должен быть числом в диапазоне (0, 1]");
  }

  return {
    capacity,
    highWatermarkRatio,
    highWatermark:
      capacity === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.ceil(capacity * highWatermarkRatio)),
    notify: typeof notify === "function" ? notify : null,
  };
}

async function emitNotification(policy, metrics, event) {
  if (!policy.notify) {
    return;
  }
  try {
    await policy.notify(event);
  } catch {
    metrics.notification_failed_total += 1;
  }
}

function toMs(value, field) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new EdgeMessageBufferError(`${field} должен быть валидной датой ISO-8601, получено ${value}`);
  }
  return ms;
}

function toIso(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

/** Проверяет инварианты записи буфера перед записью. */
function assertRecordInvariants(record) {
  if (!Number.isInteger(record.sequence_number) || record.sequence_number <= 0) {
    throw new EdgeMessageBufferError("sequence_number должен быть положительным целым");
  }
  if (!Buffer.isBuffer(record.payload_encrypted) || record.payload_encrypted.length === 0) {
    throw new EdgeMessageBufferError("payload_encrypted должен быть непустым Buffer (bytea)");
  }
  if (!record.endpoint_id || !record.idempotency_key) {
    throw new EdgeMessageBufferError("endpoint_id и idempotency_key обязательны");
  }
  if (toMs(record.ttl, "ttl") < toMs(record.received_at, "received_at")) {
    throw new EdgeMessageBufferError("ttl должен быть не раньше received_at");
  }
}

function normalizeRecord(input) {
  const receivedAt = toIso(input.received_at) ?? new Date().toISOString();
  const record = {
    id: input.id ?? randomUUID(),
    endpoint_id: input.endpoint_id,
    sequence_number: input.sequence_number,
    idempotency_key: input.idempotency_key,
    payload_encrypted: input.payload_encrypted,
    received_at: receivedAt,
    ttl: toIso(input.ttl),
    forwarded_at: toIso(input.forwarded_at) ?? null,
  };
  assertRecordInvariants(record);
  return record;
}

function orderPending(records) {
  return records.slice().sort((a, b) => {
    if (a.endpoint_id !== b.endpoint_id) {
      return a.endpoint_id < b.endpoint_id ? -1 : 1;
    }
    if (a.sequence_number !== b.sequence_number) {
      return a.sequence_number - b.sequence_number;
    }
    return toMs(a.received_at, "received_at") - toMs(b.received_at, "received_at");
  });
}

export function createInMemoryEdgeMessageBufferStore(options = {}) {
  const policy = normalizeCapacityPolicy(options);
  const byIdempotencyKey = new Map();
  const endpointSequence = new Set(); // "endpoint_id\x00sequence_number"
  const metrics = {
    enqueued_total: 0,
    duplicate_total: 0,
    forwarded_total: 0,
    expired_total: 0,
    purged_total: 0,
    capacity_high_watermark_total: 0,
    capacity_rejected_total: 0,
    backpressure_total: 0,
    notification_failed_total: 0,
  };

  function sequenceKey(record) {
    return `${record.endpoint_id}\x00${record.sequence_number}`;
  }

  async function notifyHighWatermarkIfNeeded(size) {
    if (policy.capacity === Number.POSITIVE_INFINITY || size < policy.highWatermark) {
      return;
    }
    metrics.capacity_high_watermark_total += 1;
    await emitNotification(policy, metrics, {
      type: "edge_buffer_capacity_high_watermark",
      severity: size >= policy.capacity ? "critical" : "warning",
      size,
      capacity: policy.capacity,
      high_watermark: policy.highWatermark,
      usage_ratio: size / policy.capacity,
    });
  }

  async function rejectIfFull(record) {
    if (policy.capacity === Number.POSITIVE_INFINITY || byIdempotencyKey.size < policy.capacity) {
      return;
    }

    const details = {
      endpoint_id: record.endpoint_id,
      sequence_number: record.sequence_number,
      idempotency_key: record.idempotency_key,
      size: byIdempotencyKey.size,
      capacity: policy.capacity,
    };
    metrics.capacity_rejected_total += 1;
    metrics.backpressure_total += 1;
    await emitNotification(policy, metrics, {
      type: "edge_buffer_capacity_exhausted",
      severity: "critical",
      ...details,
    });
    throw new EdgeMessageBufferBackpressureError(
      `RF-буфер Edge исчерпал ёмкость (${byIdempotencyKey.size}/${policy.capacity}); требуется backpressure на приём`,
      details,
    );
  }

  return {
    async enqueue(input) {
      const record = normalizeRecord(input);

      const existing = byIdempotencyKey.get(record.idempotency_key);
      if (existing) {
        metrics.duplicate_total += 1;
        return { inserted: false, duplicate: true, record: { ...existing } };
      }

      await rejectIfFull(record);

      const seqKey = sequenceKey(record);
      if (endpointSequence.has(seqKey)) {
        throw new EdgeMessageBufferError(
          `нарушение уникальности (endpoint_id, sequence_number): ${record.endpoint_id}/${record.sequence_number}`,
        );
      }

      byIdempotencyKey.set(record.idempotency_key, record);
      endpointSequence.add(seqKey);
      metrics.enqueued_total += 1;
      await notifyHighWatermarkIfNeeded(byIdempotencyKey.size);
      return { inserted: true, duplicate: false, record: { ...record } };
    },

    async get(idempotencyKey) {
      const record = byIdempotencyKey.get(idempotencyKey);
      return record ? { ...record } : null;
    },

    async listPendingDrain({ now = new Date().toISOString() } = {}) {
      const nowMs = toMs(now, "now");
      const pending = [];
      for (const record of byIdempotencyKey.values()) {
        if (record.forwarded_at === null && toMs(record.ttl, "ttl") >= nowMs) {
          pending.push({ ...record });
        }
      }
      return orderPending(pending);
    },

    async listExpired({ now = new Date().toISOString() } = {}) {
      const nowMs = toMs(now, "now");
      const expired = [];
      for (const record of byIdempotencyKey.values()) {
        if (record.forwarded_at === null && toMs(record.ttl, "ttl") < nowMs) {
          expired.push({ ...record });
        }
      }
      metrics.expired_total = expired.length;
      const ordered = orderPending(expired);
      if (ordered.length > 0) {
        await emitNotification(policy, metrics, {
          type: "edge_buffer_ttl_expired",
          severity: "critical",
          checked_at: toIso(now),
          expired_count: ordered.length,
          idempotency_keys: ordered.map((record) => record.idempotency_key),
        });
      }
      return ordered;
    },

    async markForwarded(idempotencyKey, forwardedAt = new Date().toISOString()) {
      const record = byIdempotencyKey.get(idempotencyKey);
      if (!record) {
        return null;
      }
      const at = toIso(forwardedAt);
      if (toMs(at, "forwarded_at") < toMs(record.received_at, "received_at")) {
        throw new EdgeMessageBufferError("forwarded_at должен быть не раньше received_at");
      }
      if (record.forwarded_at === null) {
        metrics.forwarded_total += 1;
      }
      record.forwarded_at = at;
      return { ...record };
    },

    async purgeForwarded() {
      let removed = 0;
      for (const [key, record] of byIdempotencyKey.entries()) {
        // Инвариант: удаляем только подтверждённые (forwarded_at NOT NULL).
        if (record.forwarded_at !== null) {
          byIdempotencyKey.delete(key);
          endpointSequence.delete(sequenceKey(record));
          removed += 1;
        }
      }
      metrics.purged_total += removed;
      return removed;
    },

    async size() {
      return byIdempotencyKey.size;
    },

    async pendingCount({ now = new Date().toISOString() } = {}) {
      return (await this.listPendingDrain({ now })).length;
    },

    getMetrics() {
      return { ...metrics };
    },

    getCapacityPolicy() {
      return {
        capacity: policy.capacity,
        highWatermarkRatio: policy.highWatermarkRatio,
        highWatermark: policy.highWatermark,
      };
    },
  };
}

/**
 * Postgres-хранилище RF-буфера (реальная таблица `edge_message_buffer` в
 * RF-контуре). Мирроринг in-memory контракта поверх pg-клиента.
 * @param {object} options
 * @param {{ query: Function }} options.client pg.Client/Pool
 */
export interface CreatePostgresEdgeMessageBufferStoreOptions
  extends EdgeMessageBufferCapacityOptions {
  client?: any;
}

export function createPostgresEdgeMessageBufferStore(
  options: CreatePostgresEdgeMessageBufferStoreOptions = {},
) {
  const { client } = options;
  if (!client || typeof client.query !== "function") {
    throw new EdgeMessageBufferError("client с query(sql, params) обязателен");
  }
  const policy = normalizeCapacityPolicy(options);

  function rowToRecord(row) {
    return {
      id: row.id,
      endpoint_id: row.endpoint_id,
      sequence_number: Number(row.sequence_number),
      idempotency_key: row.idempotency_key,
      payload_encrypted: Buffer.isBuffer(row.payload_encrypted)
        ? row.payload_encrypted
        : Buffer.from(row.payload_encrypted),
      received_at: toIso(row.received_at),
      ttl: toIso(row.ttl),
      forwarded_at: toIso(row.forwarded_at),
    };
  }

  const metrics = {
    enqueued_total: 0,
    duplicate_total: 0,
    forwarded_total: 0,
    expired_total: 0,
    purged_total: 0,
    capacity_high_watermark_total: 0,
    capacity_rejected_total: 0,
    backpressure_total: 0,
    notification_failed_total: 0,
  };

  return {
    async enqueue(input) {
      const record = normalizeRecord(input);

      if (policy.capacity !== Number.POSITIVE_INFINITY) {
        const existing = await this.get(record.idempotency_key);
        if (existing) {
          metrics.duplicate_total += 1;
          return { inserted: false, duplicate: true, record: existing };
        }
        const currentSize = await this.size();
        if (currentSize >= policy.capacity) {
          const details = {
            endpoint_id: record.endpoint_id,
            sequence_number: record.sequence_number,
            idempotency_key: record.idempotency_key,
            size: currentSize,
            capacity: policy.capacity,
          };
          metrics.capacity_rejected_total += 1;
          metrics.backpressure_total += 1;
          await emitNotification(policy, metrics, {
            type: "edge_buffer_capacity_exhausted",
            severity: "critical",
            ...details,
          });
          throw new EdgeMessageBufferBackpressureError(
            `RF-буфер Edge исчерпал ёмкость (${currentSize}/${policy.capacity}); требуется backpressure на приём`,
            details,
          );
        }
      }

      let result;
      try {
        result = await client.query(
          `
            INSERT INTO edge_message_buffer
              (id, endpoint_id, sequence_number, idempotency_key,
               payload_encrypted, received_at, ttl, forwarded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING *
          `,
          [
            record.id,
            record.endpoint_id,
            record.sequence_number,
            record.idempotency_key,
            record.payload_encrypted,
            record.received_at,
            record.ttl,
            record.forwarded_at,
          ],
        );
      } catch (error) {
        if (error?.constraint === "edge_message_buffer_endpoint_sequence_unique") {
          throw new EdgeMessageBufferError(
            `нарушение уникальности (endpoint_id, sequence_number): ${record.endpoint_id}/${record.sequence_number}`,
          );
        }
        throw error;
      }

      if (result.rowCount === 0) {
        const existing = await this.get(record.idempotency_key);
        metrics.duplicate_total += 1;
        return { inserted: false, duplicate: true, record: existing };
      }

      metrics.enqueued_total += 1;
      const size = await this.size();
      if (policy.capacity !== Number.POSITIVE_INFINITY && size >= policy.highWatermark) {
        metrics.capacity_high_watermark_total += 1;
        await emitNotification(policy, metrics, {
          type: "edge_buffer_capacity_high_watermark",
          severity: size >= policy.capacity ? "critical" : "warning",
          size,
          capacity: policy.capacity,
          high_watermark: policy.highWatermark,
          usage_ratio: size / policy.capacity,
        });
      }
      return { inserted: true, duplicate: false, record: rowToRecord(result.rows[0]) };
    },

    async get(idempotencyKey) {
      const result = await client.query(
        "SELECT * FROM edge_message_buffer WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      return result.rowCount === 0 ? null : rowToRecord(result.rows[0]);
    },

    async listPendingDrain({ now = new Date().toISOString() } = {}) {
      const result = await client.query(
        `
          SELECT *
          FROM edge_message_buffer
          WHERE forwarded_at IS NULL
            AND ttl >= $1
          ORDER BY endpoint_id, sequence_number, received_at
        `,
        [now],
      );
      return result.rows.map(rowToRecord);
    },

    async listExpired({ now = new Date().toISOString() } = {}) {
      const result = await client.query(
        `
          SELECT *
          FROM edge_message_buffer
          WHERE forwarded_at IS NULL
            AND ttl < $1
          ORDER BY endpoint_id, sequence_number, received_at
        `,
        [now],
      );
      metrics.expired_total = result.rowCount;
      const expired = result.rows.map(rowToRecord);
      if (expired.length > 0) {
        await emitNotification(policy, metrics, {
          type: "edge_buffer_ttl_expired",
          severity: "critical",
          checked_at: toIso(now),
          expired_count: expired.length,
          idempotency_keys: expired.map((record) => record.idempotency_key),
        });
      }
      return expired;
    },

    async markForwarded(idempotencyKey, forwardedAt = new Date().toISOString()) {
      const result = await client.query(
        `
          UPDATE edge_message_buffer
          SET forwarded_at = $2
          WHERE idempotency_key = $1
            AND forwarded_at IS NULL
          RETURNING *
        `,
        [idempotencyKey, toIso(forwardedAt)],
      );
      if (result.rowCount === 0) {
        return this.get(idempotencyKey);
      }
      metrics.forwarded_total += 1;
      return rowToRecord(result.rows[0]);
    },

    async purgeForwarded() {
      const result = await client.query(
        "DELETE FROM edge_message_buffer WHERE forwarded_at IS NOT NULL",
      );
      metrics.purged_total += result.rowCount;
      return result.rowCount;
    },

    async size() {
      const result = await client.query("SELECT COUNT(*)::int AS count FROM edge_message_buffer");
      return result.rows[0].count;
    },

    async pendingCount({ now = new Date().toISOString() } = {}) {
      const result = await client.query(
        "SELECT COUNT(*)::int AS count FROM edge_message_buffer WHERE forwarded_at IS NULL AND ttl >= $1",
        [now],
      );
      return result.rows[0].count;
    },

    getMetrics() {
      return { ...metrics };
    },

    getCapacityPolicy() {
      return {
        capacity: policy.capacity,
        highWatermarkRatio: policy.highWatermarkRatio,
        highWatermark: policy.highWatermark,
      };
    },
  };
}
