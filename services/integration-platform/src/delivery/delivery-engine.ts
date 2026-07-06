import { createBackoffPolicy } from "./backoff.js";
import { ChannelDeliveryError, classifyDeliveryError } from "./errors.js";
import { createChannelResilience } from "./resilience.js";

/**
 * Движок надёжной доставки SVC-INT (CP-6, M4).
 *
 * Объединяет три механизма массовой доставки через адаптеры:
 *   1. Ретраи и обработка ошибок (ТЗ §10.8): классификация повторяемости,
 *      повтор с экспоненциальным бэкоффом, фиксация каждой попытки в
 *      `message_delivery_attempts` через Backend и уведомление ядра.
 *   2. Rate limiting на канал (ТЗ §10.9): списание токена канала перед вызовом
 *      внешнего API, backpressure при исчерпании.
 *   3. Идемпотентная доставка (ТЗ §11.12): сквозной `idempotency_key`
 *      (= `message_id`) — повтор с обработанным ключом отбрасывается без
 *      создания второго внешнего сообщения.
 */
/** Опции {@link createDeliveryEngine}. */
export interface DeliveryEngineOptions {
  channel?: any;
  backendClient?: any;
  rateLimiter?: any;
  backoff?: any;
  resilience?: any;
  queue?: any;
  now?: () => string;
  sleep?: (ms: any) => Promise<unknown>;
  maxBackpressureWaitMs?: number;
}

export function createDeliveryEngine({
  channel,
  backendClient,
  rateLimiter,
  backoff = createBackoffPolicy(),
  resilience = {},
  queue = {},
  now = () => new Date().toISOString(),
  sleep = defaultSleep,
  maxBackpressureWaitMs = Number.POSITIVE_INFINITY,
}: DeliveryEngineOptions = {}) {
  if (
    !channel ||
    (typeof channel.deliver !== "function" &&
      typeof channel.acceptEgressDelivery !== "function")
  ) {
    throw new TypeError(
      "channel with a deliver() or acceptEgressDelivery() method is required",
    );
  }
  if (!backendClient || typeof backendClient.recordAttempt !== "function") {
    throw new TypeError("backendClient with a recordAttempt() method is required");
  }

  const processed = new Map(); // idempotency_key -> final result
  const channelStates = new Map(); // channel_type -> resilience guard
  const deliveryQueue = createAsyncDeliveryQueue({ queue, sleep });
  const metrics = {
    deliveries_total: 0,
    delivered_total: 0,
    failed_total: 0,
    duplicate_total: 0,
    retries_total: 0,
    attempts_total: 0,
    attempt_record_failures_total: 0,
    queued_total: 0,
    queue_retries_total: 0,
    degraded_total: 0,
    timeout_total: 0,
    circuit_open_total: 0,
    bulkhead_rejected_total: 0,
  };

  async function recordAttempt(context, attemptNo, status, error) {
    metrics.attempts_total += 1;
    try {
      await backendClient.recordAttempt({
        organizationId: context.organizationId,
        messageId: context.messageId,
        adapter: context.adapter,
        attemptNo,
        status,
        error: error ?? null,
        occurredAt: now(),
      });
    } catch (recordError) {
      // Недоступность Backend не должна ронять доставку: фиксируем метрикой,
      // продолжаем. Полноценная деградация Backend — предмет M5.
      metrics.attempt_record_failures_total += 1;
      return { recorded: false, error: recordError };
    }
    return { recorded: true };
  }

  const api = {
    getMetrics() {
      return { ...metrics };
    },

    getChannelState(channelType) {
      const state = channelStates.get(channelType);
      if (!state) {
        return {
          circuit: "closed",
          active: 0,
          queued: 0,
        };
      }
      return state.getSnapshot();
    },

    getQueueSnapshot() {
      return deliveryQueue.getSnapshot();
    },

    getDeliveryStatus(idempotencyKey) {
      if (processed.has(idempotencyKey)) {
        return structuredCloneResult(processed.get(idempotencyKey));
      }

      const queued = deliveryQueue.getStatus(idempotencyKey);
      return queued ? { ...queued } : null;
    },

    isProcessed(idempotencyKey) {
      return processed.has(idempotencyKey);
    },

    enqueue(egressDelivery) {
      const context = extractContext(egressDelivery);

      if (processed.has(context.idempotencyKey)) {
        metrics.duplicate_total += 1;
        return {
          ...structuredCloneResult(processed.get(context.idempotencyKey)),
          accepted: true,
          queued: false,
          duplicate: true,
        };
      }

      const accepted = deliveryQueue.enqueue({
        key: context.idempotencyKey,
        payload: egressDelivery,
        run: async () => api.deliver(egressDelivery),
        shouldRetry: (result) => result?.retryable === true && !result?.delivered,
        onQueued: () => {
          metrics.queued_total += 1;
        },
        onDuplicate: () => {
          metrics.duplicate_total += 1;
        },
        onRetry: () => {
          metrics.queue_retries_total += 1;
        },
      });

      if (!accepted.accepted) {
        return {
          accepted: false,
          queued: false,
          delivered: false,
          duplicate: false,
          status: "queue_full",
          idempotency_key: context.idempotencyKey,
          message_id: context.messageId,
          adapter: context.adapter,
          error: "delivery queue is full",
          retryable: true,
        };
      }

      return {
        accepted: true,
        queued: true,
        delivered: false,
        duplicate: accepted.duplicate,
        status: "queued",
        idempotency_key: context.idempotencyKey,
        message_id: context.messageId,
        adapter: context.adapter,
      };
    },

    async deliver(egressDelivery) {
      const context = extractContext(egressDelivery);
      metrics.deliveries_total += 1;

      // Идемпотентность на уровне движка: повторный egress с тем же ключом
      // не запускает доставку заново (ТЗ §11.12).
      if (processed.has(context.idempotencyKey)) {
        metrics.duplicate_total += 1;
        return {
          ...structuredCloneResult(processed.get(context.idempotencyKey)),
          duplicate: true,
        };
      }

      // Rate limiting на канал с backpressure (ТЗ §10.9).
      if (rateLimiter && typeof rateLimiter.acquire === "function") {
        await rateLimiter.acquire(context.adapter, {
          maxWaitMs: maxBackpressureWaitMs,
        });
      }

      const maxAttempts = backoff.maxAttempts;
      let lastClassification;
      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) {
          metrics.retries_total += 1;
        }

        try {
          const deliveryResult = await deliverToExternalChannel(context, egressDelivery);

          await recordAttempt(context, attempt, "delivered", null);

          const result = {
            accepted: true,
            queued: false,
            delivered: true,
            duplicate: Boolean(deliveryResult?.duplicate),
            attempts: attempt,
            idempotency_key: context.idempotencyKey,
            message_id: context.messageId,
            adapter: context.adapter,
            external_message_id: deliveryResult?.external_message_id ?? null,
            status: "delivered",
          };

          processed.set(context.idempotencyKey, result);
          metrics.delivered_total += 1;
          if (result.duplicate) {
            metrics.duplicate_total += 1;
          }
          return result;
        } catch (error) {
          lastError = error;
          lastClassification = classifyDeliveryError(error);
          recordDegradationMetric(lastClassification);

          await recordAttempt(context, attempt, "failed", error.message);

          const isLastAttempt = attempt >= maxAttempts;
          if (!lastClassification.retryable || isLastAttempt) {
            const result = {
              accepted: false,
              queued: false,
              delivered: false,
              duplicate: false,
              attempts: attempt,
              idempotency_key: context.idempotencyKey,
              message_id: context.messageId,
              adapter: context.adapter,
              status: "failed",
              error: error.message,
              error_category: lastClassification.category,
              retryable: lastClassification.retryable,
            };
            if (!result.retryable) {
              processed.set(context.idempotencyKey, result);
            }
            metrics.failed_total += 1;
            return result;
          }

          const delay = backoff.delayForAttempt(attempt, {
            retryAfterMs: lastClassification.retryAfterMs,
          });
          await sleep(delay);
        }
      }

      // Недостижимо: цикл всегда возвращает результат, но оставляем защиту.
      metrics.failed_total += 1;
      return {
        accepted: false,
        queued: false,
        delivered: false,
        duplicate: false,
        attempts: maxAttempts,
        idempotency_key: context.idempotencyKey,
        message_id: context.messageId,
        adapter: context.adapter,
        status: "failed",
        error: lastError?.message ?? "delivery exhausted retries",
        error_category: lastClassification?.category ?? "unknown",
        retryable: Boolean(lastClassification?.retryable),
      };
    },
  };

  return api;

  async function deliverToExternalChannel(context, egressDelivery) {
    const guard = getChannelResilience(context.adapter);
    const result = await guard.execute(({ signal }) => {
      if (typeof channel.acceptEgressDelivery === "function") {
        return deliverViaM2Adapter(channel, egressDelivery, signal);
      }

      return channel.deliver({
        idempotencyKey: context.idempotencyKey,
        channelType: context.channelType,
        delivery: egressDelivery,
        message: egressDelivery.message,
        signal,
      });
    });

    if (result.ok) {
      return result.value;
    }

    throw result.error;
  }

  function getChannelResilience(channelType) {
    if (!channelStates.has(channelType)) {
      channelStates.set(channelType, createChannelResilience(resilience));
    }
    return channelStates.get(channelType);
  }

  function recordDegradationMetric(classification) {
    if (classification.retryable) {
      metrics.degraded_total += 1;
    }

    if (classification.category === "timeout") {
      metrics.timeout_total += 1;
    }
    if (classification.category === "circuit_open") {
      metrics.circuit_open_total += 1;
    }
    if (classification.category === "bulkhead_full") {
      metrics.bulkhead_rejected_total += 1;
    }
  }
}

async function deliverViaM2Adapter(adapter, egressDelivery, signal) {
  const result = await adapter.acceptEgressDelivery(egressDelivery, { signal });
  if (!result?.accepted) {
    throw new ChannelDeliveryError(
      result?.errors?.join("; ") || "M2 channel adapter rejected delivery",
      {
        retryable: false,
        category: "adapter_rejected",
      },
    );
  }

  return {
    delivered: true,
    duplicate: Boolean(result.duplicate),
    external_message_id:
      result.delivery?.external_message_id ??
      result.external_message_id ??
      result.delivery?.provider_response?.external_message_id ??
      null,
  };
}

function createAsyncDeliveryQueue({ queue, sleep }) {
  const enabled = queue?.enabled === true;
  const maxSize = Math.max(1, queue?.maxSize ?? 1024);
  const concurrency = Math.max(1, queue?.concurrency ?? 4);
  const maxAttempts = Math.max(1, queue?.maxAttempts ?? 10);
  const retryDelayMs = Math.max(0, queue?.retryDelayMs ?? 1000);
  const pending = [];
  const queued = new Map();
  let active = 0;
  let draining = false;

  function enqueue(item) {
    if (!enabled) {
      return { accepted: false, reason: "queue_disabled" };
    }

    const existing = queued.get(item.key);
    if (existing) {
      item.onDuplicate?.();
      return { accepted: true, duplicate: true };
    }

    if (queued.size >= maxSize) {
      return { accepted: false, reason: "queue_full" };
    }

    const queuedItem = {
      ...item,
      attempts: 0,
      status: "queued",
    };
    queued.set(item.key, queuedItem);
    pending.push(queuedItem);
    item.onQueued?.();
    scheduleDrain();
    return { accepted: true, duplicate: false };
  }

  function getSnapshot() {
    return {
      enabled,
      queued: queued.size,
      pending: pending.length,
      active,
    };
  }

  function getStatus(key) {
    const item = queued.get(key);
    if (!item) {
      return null;
    }

    return {
      status: item.status,
      queued: true,
      attempts: item.attempts,
      idempotency_key: item.key,
    };
  }

  function scheduleDrain() {
    if (draining) {
      return;
    }
    draining = true;
    queueMicrotask(drain);
  }

  function drain() {
    draining = false;

    while (active < concurrency && pending.length > 0) {
      const item = pending.shift();
      active += 1;
      item.status = "running";
      item.attempts += 1;

      Promise.resolve()
        .then(() => item.run())
        .then((result) => {
          if (item.shouldRetry?.(result) && item.attempts < maxAttempts) {
            item.status = "retry_wait";
            item.onRetry?.(result);
            scheduleRetry(item);
            return;
          }

          item.status = result?.delivered ? "delivered" : "failed";
          queued.delete(item.key);
        })
        .catch(() => {
          item.status = "failed";
          queued.delete(item.key);
        })
        .finally(() => {
          active = Math.max(0, active - 1);
          scheduleDrain();
        });
    }
  }

  function scheduleRetry(item) {
    const retry = async () => {
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
      item.status = "queued";
      pending.push(item);
      scheduleDrain();
    };

    void retry();
  }

  return { enqueue, getSnapshot, getStatus };
}

function extractContext(egressDelivery) {
  if (!egressDelivery || typeof egressDelivery !== "object") {
    throw new TypeError("egressDelivery must be an object");
  }

  const message = egressDelivery.message;
  if (!message || typeof message !== "object") {
    throw new TypeError("egressDelivery.message must be an object");
  }

  const idempotencyKey = egressDelivery.idempotency_key;
  const messageId = message.message_id;
  const organizationId = message.organization_id;
  const channelType = message.channel_type ?? message.channel;
  const adapter = channelType;

  assertNonEmptyString(idempotencyKey, "idempotency_key");
  assertNonEmptyString(messageId, "message.message_id");
  assertNonEmptyString(organizationId, "message.organization_id");
  assertNonEmptyString(channelType, "message.channel_type");

  // Сквозной ключ должен совпадать с message_id (ТЗ §11.12).
  if (idempotencyKey !== messageId) {
    throw new TypeError("idempotency_key must match message.message_id");
  }

  return { idempotencyKey, messageId, organizationId, channelType, adapter };
}

function structuredCloneResult(result) {
  return { ...result };
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
