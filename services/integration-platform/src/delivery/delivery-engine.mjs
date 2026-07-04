import { createBackoffPolicy } from "./backoff.mjs";
import { classifyDeliveryError } from "./errors.mjs";

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
export function createDeliveryEngine({
  channel,
  backendClient,
  rateLimiter,
  backoff = createBackoffPolicy(),
  now = () => new Date().toISOString(),
  sleep = defaultSleep,
  maxBackpressureWaitMs = Number.POSITIVE_INFINITY,
} = {}) {
  if (!channel || typeof channel.deliver !== "function") {
    throw new TypeError("channel with a deliver() method is required");
  }
  if (!backendClient || typeof backendClient.recordAttempt !== "function") {
    throw new TypeError("backendClient with a recordAttempt() method is required");
  }

  const processed = new Map(); // idempotency_key -> final result
  const metrics = {
    deliveries_total: 0,
    delivered_total: 0,
    failed_total: 0,
    duplicate_total: 0,
    retries_total: 0,
    attempts_total: 0,
    attempt_record_failures_total: 0,
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

  return {
    getMetrics() {
      return { ...metrics };
    },

    isProcessed(idempotencyKey) {
      return processed.has(idempotencyKey);
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
          const deliveryResult = await channel.deliver({
            idempotencyKey: context.idempotencyKey,
            channelType: context.channelType,
            message: egressDelivery.message,
          });

          await recordAttempt(context, attempt, "delivered", null);

          const result = {
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

          await recordAttempt(context, attempt, "failed", error.message);

          const isLastAttempt = attempt >= maxAttempts;
          if (!lastClassification.retryable || isLastAttempt) {
            const result = {
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
            processed.set(context.idempotencyKey, result);
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
