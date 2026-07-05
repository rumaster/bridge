import { createEdgeTunnelMessage } from "../../../packages/contracts/src/c9.js";

import {
  EdgeMessageBufferBackpressureError,
  createInMemoryEdgeMessageBufferStore,
} from "./edge-message-buffer.js";
import { createEdgeSequencer } from "./edge-sequencer.js";
import { VpnTunnelBackpressureError, VpnTunnelChannelDownError } from "./vpn-tunnel.js";

/**
 * Edge Cluster в РФ — региональная точка входа (ТЗ §7.3, §7.6, §7.9–§7.10, §7.14, CP-7).
 *
 * Оркестратор Edge, связывающий воедино:
 *   - секвенсор — присвоение `sequence_number` на входе (§7.10, ключ endpoint_id);
 *   - шифр — шифрование payload перед фиксацией (§7.9/§7.14);
 *   - RF-буфер — первичная фиксация ПДн субъектов РФ в RF-контуре ДО пересылки
 *     за рубеж (RF-first, §7.14) и буферизация при разрыве (§7.9);
 *   - VPN Tunnel — защищённая пересылка в Application-контур (§7.8).
 *
 * Модель RF-first: КАЖДОЕ сообщение сначала фиксируется в RF-буфере (шифртекст,
 * ttl, sequence_number, idempotency_key), и только затем пересылается через
 * туннель. Успешная пересылка помечается `forwarded_at`. При недоступности канала
 * (разрыв/backpressure) запись остаётся в буфере (pending) и автоматически
 * дренажируется после восстановления — без потерь, порядок восстанавливает ядро
 * по `sequence_number`, дедуп — по сквозному `idempotency_key` (совместно с SVC-CORE).
 */
export class EdgeClusterError extends Error {
  constructor(message) {
    super(message);
    this.name = "EdgeClusterError";
  }
}

const DEFAULT_BUFFER_TTL_MS = 60 * 60 * 1000; // 1 час

export interface CreateEdgeClusterOptions {
  cipher?: any;
  tunnel?: any;
  sequencer?: any;
  bufferStore?: any;
  now?: () => string;
  bufferTtlMs?: number;
  region?: string;
}

export function createEdgeCluster({
  cipher,
  tunnel,
  sequencer = createEdgeSequencer(),
  bufferStore = createInMemoryEdgeMessageBufferStore(),
  now = () => new Date().toISOString(),
  bufferTtlMs = DEFAULT_BUFFER_TTL_MS,
  region = "RF",
}: CreateEdgeClusterOptions = {}) {
  if (!cipher || typeof cipher.encrypt !== "function" || typeof cipher.decrypt !== "function") {
    throw new EdgeClusterError("cipher {encrypt, decrypt} is required (RF payload cipher)");
  }
  if (!tunnel || typeof tunnel.send !== "function") {
    throw new EdgeClusterError("tunnel (VPN edge client) is required");
  }

  const metrics = {
    ingested_total: 0,
    duplicate_total: 0,
    fixed_in_rf_total: 0,
    forwarded_total: 0,
    buffered_offline_total: 0,
    drained_total: 0,
    backpressure_total: 0,
    buffer_backpressure_total: 0,
    channel_down_total: 0,
    recovery_total: 0,
    expired_skipped_total: 0,
  };

  function aadFor(record) {
    return {
      endpoint_id: record.endpoint_id,
      sequence_number: record.sequence_number,
      idempotency_key: record.idempotency_key,
    };
  }

  function ttlFrom(receivedAt) {
    return new Date(new Date(receivedAt).getTime() + bufferTtlMs).toISOString();
  }

  function getBufferCapacityPolicy() {
    if (typeof bufferStore.getCapacityPolicy !== "function") {
      return {
        capacity: Number.POSITIVE_INFINITY,
        highWatermark: Number.POSITIVE_INFINITY,
        highWatermarkRatio: 0.8,
      };
    }
    return bufferStore.getCapacityPolicy();
  }

  async function pendingCountAt(at) {
    if (typeof bufferStore.pendingCount === "function") {
      return bufferStore.pendingCount({ now: at });
    }
    return (await bufferStore.listPendingDrain({ now: at })).length;
  }

  function rtoMs(startedAt, completedAt) {
    const started = Date.parse(startedAt);
    const completed = Date.parse(completedAt);
    if (Number.isNaN(started) || Number.isNaN(completed)) {
      return 0;
    }
    return Math.max(0, completed - started);
  }

  function isTunnelConnected() {
    return typeof tunnel.isConnected === "function" ? tunnel.isConnected() : true;
  }

  /** Пересылает C9-сообщение через туннель; возвращает {forwarded, ack, reason}. */
  async function tryForward(payload) {
    if (typeof tunnel.isConnected === "function" && !tunnel.isConnected()) {
      return { forwarded: false, reason: "disconnected" };
    }
    const tunnelMessage = createEdgeTunnelMessage({ payload, receivedAt: now() });
    try {
      const ack = await tunnel.send(tunnelMessage);
      return { forwarded: true, ack };
    } catch (error) {
      if (error instanceof VpnTunnelBackpressureError) {
        metrics.backpressure_total += 1;
        return { forwarded: false, reason: "backpressure" };
      }
      if (error instanceof VpnTunnelChannelDownError) {
        metrics.channel_down_total += 1;
        return { forwarded: false, reason: "channel_down" };
      }
      throw error;
    }
  }

  async function drainPending() {
    const startedAt = now();
    if (typeof tunnel.ensureConnected === "function") {
      await tunnel.ensureConnected();
    }

    const expired =
      typeof bufferStore.listExpired === "function"
        ? await bufferStore.listExpired({ now: startedAt })
        : [];
    const pending = await bufferStore.listPendingDrain({ now: startedAt });
    const forwarded = [];
    let interruptedReason;

    for (const record of pending) {
      const payload = cipher.decrypt(record.payload_encrypted, { aad: aadFor(record) });
      const result = await tryForward(payload);
      if (!result.forwarded) {
        // Канал снова недоступен/перегружен — оставляем остаток в буфере.
        interruptedReason = result.reason;
        break;
      }
      await bufferStore.markForwarded(record.idempotency_key, now());
      metrics.drained_total += 1;
      forwarded.push({
        endpoint_id: record.endpoint_id,
        sequence_number: record.sequence_number,
        idempotency_key: record.idempotency_key,
        ack: result.ack,
      });
    }

    const completedAt = now();
    const pendingAfter = await pendingCountAt(completedAt);
    metrics.recovery_total += 1;
    metrics.expired_skipped_total += expired.length;

    return {
      drained: forwarded.length,
      forwarded,
      reason: interruptedReason,
      recovery: {
        started_at: startedAt,
        completed_at: completedAt,
        rto_ms: rtoMs(startedAt, completedAt),
        pending_before: pending.length,
        pending_after: pendingAfter,
        expired_skipped: expired.length,
        rpo: {
          capacity: getBufferCapacityPolicy().capacity,
          ttl_ms: bufferTtlMs,
          ttl_expired: expired.length,
        },
      },
    };
  }

  return {
    region,

    /**
     * Приём сообщения на входе Edge (РФ).
     * Присваивает sequence_number, шифрует и фиксирует в RF-буфере (RF-first),
     * затем пытается переслать через туннель.
     * @param {object} message канонический C1 (без sequence_number — назначается здесь)
     */
    async ingest(message) {
      if (!message?.endpoint_id) {
        throw new EdgeClusterError("message.endpoint_id (ключ партиционирования) обязателен");
      }
      if (!message.id) {
        throw new EdgeClusterError("message.id обязателен (источник idempotency_key)");
      }

      const endpointId = message.endpoint_id;
      const idempotencyKey = message.idempotency_key ?? message.id;
      const receivedAt = now();
      const backlogBefore = await pendingCountAt(receivedAt);

      // §7.10 — присвоение sequence_number на входе Edge (ключ endpoint_id).
      const sequenceNumber = sequencer.assign(endpointId);
      const payload = {
        ...message,
        idempotency_key: idempotencyKey,
        sequence_number: sequenceNumber,
      };

      const aad = {
        endpoint_id: endpointId,
        sequence_number: sequenceNumber,
        idempotency_key: idempotencyKey,
      };
      // §7.9/§7.14 — шифруем payload и фиксируем в RF-контуре ДО пересылки.
      const payloadEncrypted = cipher.encrypt(payload, { aad });

      let enqueueResult;
      try {
        enqueueResult = await bufferStore.enqueue({
          endpoint_id: endpointId,
          sequence_number: sequenceNumber,
          idempotency_key: idempotencyKey,
          payload_encrypted: payloadEncrypted,
          received_at: receivedAt,
          ttl: ttlFrom(receivedAt),
        });
      } catch (error) {
        if (error instanceof EdgeMessageBufferBackpressureError) {
          metrics.buffer_backpressure_total += 1;
        }
        throw error;
      }

      metrics.ingested_total += 1;

      if (enqueueResult.duplicate) {
        // Сквозной дедуп на входе Edge: повтор idempotency_key не фиксируется заново.
        metrics.duplicate_total += 1;
        // Откатывать sequence_number не нужно: ядро дедуплицирует по idempotency_key.
        return {
          endpoint_id: endpointId,
          idempotency_key: idempotencyKey,
          sequence_number: enqueueResult.record.sequence_number,
          duplicate: true,
          fixed_in_rf: false,
          forwarded: false,
        };
      }

      metrics.fixed_in_rf_total += 1;

      if (backlogBefore > 0 && isTunnelConnected()) {
        const drainResult = await drainPending();
        const currentForward = drainResult.forwarded.find(
          (item) => item.idempotency_key === idempotencyKey,
        );

        return {
          endpoint_id: endpointId,
          idempotency_key: idempotencyKey,
          sequence_number: sequenceNumber,
          duplicate: false,
          fixed_in_rf: true,
          forwarded: Boolean(currentForward),
          reason: currentForward ? undefined : drainResult.reason,
          ack: currentForward?.ack,
          auto_drained: drainResult.drained,
          recovery: drainResult.recovery,
        };
      }

      const forwardResult = await tryForward(payload);
      if (forwardResult.forwarded) {
        await bufferStore.markForwarded(idempotencyKey, now());
        metrics.forwarded_total += 1;
      } else {
        metrics.buffered_offline_total += 1;
      }

      return {
        endpoint_id: endpointId,
        idempotency_key: idempotencyKey,
        sequence_number: sequenceNumber,
        duplicate: false,
        fixed_in_rf: true,
        forwarded: forwardResult.forwarded,
        reason: forwardResult.reason,
        ack: forwardResult.ack,
      };
    },

    /**
     * Автоматический дренаж RF-буфера после восстановления канала (§7.9).
     * Восстанавливает туннель (авто-recovery), пересылает pending-записи в порядке
     * (endpoint_id, sequence_number) и помечает их forwarded. Без потерь; порядок
     * и финальный дедуп — на приёмнике (ядро, §7.10/§11.12).
     */
    async drain() {
      return drainPending();
    },

    isConnected() {
      return isTunnelConnected();
    },

    async pendingCount() {
      return bufferStore.pendingCount({ now: now() });
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
