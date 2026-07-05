import { createBroadcastStateChangedEvent } from "../../../../packages/contracts/src/c8.js";

import { buildBroadcastDraft } from "./campaign-message-factory.js";
import {
  channelSupportsType,
  resolveChannelRateLimit,
} from "./channel-capability.js";
import { createBroadcastRateLimiter } from "./broadcast-rate-limiter.js";
import { createBroadcastBackoff } from "./broadcast-backoff.js";
import { createBroadcastStats } from "./broadcast-stats.js";

/**
 * Оркестратор запуска кампании через единый механизм ядра (CP-6, M4).
 *
 * Связывает четыре механизма запуска (ТЗ §14.3, §14.6, §14.8, §14.9):
 *   1. **Идемпотентная генерация** C1-черновиков на получателя (message factory):
 *      `idempotency_key = message_id`, повторный запуск не создаёт дублей.
 *   2. **Доставка строго через ядро** (C1/C2): SVC-BCAST отдаёт черновик
 *      координатору ядра и НИКОГДА не обращается к адаптерам напрямую (§14.3).
 *   3. **Rate limiting и батчинг** на канал/организацию с учётом Capability (C6).
 *   4. **Ретраи** временных ошибок ядра с экспоненциальным бэкоффом,
 *      согласованные со сквозной идемпотентностью (без дублей, §11.12).
 * Итог — `broadcast_stats` (prepared/sent/delivered/failed) и события
 * `broadcast.state_changed` (C7) на переходах статуса кампании.
 */
export function createCampaignRunner({
  core,
  rateLimiter = createBroadcastRateLimiter(),
  backoff = createBroadcastBackoff(),
  capabilities = {},
  clock = () => new Date().toISOString(),
  sleep = defaultSleep,
  batchSize = 100,
  coreMaxAttempts,
  maxBackpressureWaitMs = Number.POSITIVE_INFINITY,
} = {}) {
  if (!core || typeof core.deliver !== "function") {
    throw new TypeError("core with deliver(draft) is required");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError("batchSize must be a positive integer");
  }

  /**
   * Запускает кампанию: генерирует сообщения, доставляет через ядро, собирает
   * статистику и события.
   *
   * @param {object} broadcast Кампания (`id`, `organization_id`, `template`,
   *   `filter`, `rate_limit`, `status`).
   * @param {import("./campaign-message-factory.js").CampaignRecipient[]} recipients
   *   Материализованный сегмент получателей (`broadcast_recipients`, ТЗ §14.4).
   * @param {{ startIdempotencyKey: string, mode?: string, reason?: string }} options
   */
  async function run(broadcast, recipients, options = {}) {
    if (!broadcast || typeof broadcast !== "object") {
      throw new TypeError("broadcast must be an object");
    }
    if (!Array.isArray(recipients)) {
      throw new TypeError("recipients must be an array");
    }
    const startIdempotencyKey =
      options.startIdempotencyKey ?? `${broadcast.id}:start`;

    const events = [];
    const previousStatus = broadcast.status ?? "scheduled";
    events.push(
      emitState({
        broadcast,
        previousStatus,
        status: "running",
        startIdempotencyKey,
        reason: options.reason ?? "broadcast_started",
      }),
    );

    const stats = createBroadcastStats({ now: clock });
    const results = [];
    const batches = chunk(recipients, batchSize);

    for (const batch of batches) {
      for (const recipient of batch) {
        const descriptor = capabilities[recipient.channel];

        // (C6) Несовместимые с каналом сообщения не формируются (плана §7).
        if (!channelSupportsType(descriptor, broadcast.template.type)) {
          stats.markSkipped(clock());
          results.push({
            client_id: recipient.client_id,
            channel: recipient.channel,
            skipped: true,
            reason: "channel_incompatible",
          });
          continue;
        }

        // (C6/§14.6) Rate limiting на канал+организацию с учётом Capability.
        const messagesPerMinute = resolveChannelRateLimit(
          descriptor,
          broadcast.template.type,
          broadcast.rate_limit ?? {},
        );
        await rateLimiter.acquire(
          `${broadcast.organization_id}:${recipient.channel}`,
          {
            messagesPerMinute,
            burst: broadcast.rate_limit?.burst,
            maxWaitMs: maxBackpressureWaitMs,
          },
        );

        const { draft, message_id } = buildBroadcastDraft({
          broadcast,
          recipient,
          startIdempotencyKey,
          createdAt: clock(),
        });
        stats.markPrepared(clock());

        const result = await deliverWithRetries(draft);
        stats.recordStatus(result.status, clock());
        results.push({
          client_id: recipient.client_id,
          channel: recipient.channel,
          message_id,
          status: result.status,
          duplicate: Boolean(result.duplicate),
          delivered: Boolean(result.delivered),
          error: result.error ?? null,
        });
      }
    }

    const snapshot = stats.snapshot();
    const finalStatus =
      snapshot.prepared > 0 && snapshot.sent === 0 ? "failed" : "done";

    events.push(
      emitState({
        broadcast,
        previousStatus: "running",
        status: finalStatus,
        startIdempotencyKey,
        reason: finalStatus === "failed" ? "all_deliveries_failed" : "broadcast_completed",
      }),
    );

    return {
      broadcast_id: broadcast.id,
      organization_id: broadcast.organization_id,
      status: finalStatus,
      stats: snapshot,
      skipped: stats.skipped(),
      batches: batches.length,
      results,
      events,
    };
  }

  /**
   * Доставка одного черновика через ядро с ретраями временных ошибок.
   *
   * Ретраится только **бросок** координатора ядра (ядро/транспорт временно
   * недоступны). Повтор безопасен — тот же `message_id` дедуплицируется ядром.
   * Терминальный отказ доставки (ядро вернуло результат с `delivered=false`)
   * НЕ ретраится: адаптерные повторы уже выполнены внутри ядра.
   */
  async function deliverWithRetries(draft) {
    const maxAttempts = backoff.maxAttempts;
    let lastError;

    // Опции для координатора ядра: пробрасываем coreMaxAttempts только когда он
    // задан явно, иначе ядро использует свой собственный бюджет адаптерных
    // повторов (координатор сам доводит транзиентные отказы адаптера до успеха).
    const coreOptions = coreMaxAttempts ? { maxAttempts: coreMaxAttempts } : {};

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await core.deliver(draft, coreOptions);
        return normalizeResult(result);
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error);
        if (!retryable || attempt >= maxAttempts) {
          return {
            status: "failed",
            delivered: false,
            duplicate: false,
            error: error.message,
          };
        }
        await sleep(backoff.delayForAttempt(attempt));
      }
    }

    return {
      status: "failed",
      delivered: false,
      duplicate: false,
      error: lastError?.message ?? "core delivery exhausted retries",
    };
  }

  function emitState({ broadcast, previousStatus, status, startIdempotencyKey, reason }) {
    const event = createBroadcastStateChangedEvent({
      eventId: `${broadcast.id}:${status}:${startIdempotencyKey}`,
      organizationId: broadcast.organization_id,
      broadcastId: broadcast.id,
      previousStatus,
      status,
      changedAt: clock(),
      reason,
    });
    return event;
  }

  return { run };
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    return { status: "failed", delivered: false, duplicate: false, error: "invalid core result" };
  }
  // Статус доставки берём из ответа ядра; если ядро его не отдало —
  // выводим из флага delivered.
  const status = typeof result.status === "string"
    ? result.status
    : result.delivered
      ? "sent"
      : "failed";
  return {
    status,
    delivered: Boolean(result.delivered),
    duplicate: Boolean(result.duplicate),
    error: result.error ?? null,
  };
}

/**
 * Классификация повторяемости ошибки координатора ядра. Явный флаг
 * `retryable === false` (например, ошибка валидации черновика) отключает повтор;
 * прочие броски считаем временными (ядро/транспорт недоступны).
 */
function isRetryable(error) {
  if (error && typeof error.retryable === "boolean") {
    return error.retryable;
  }
  if (error && error.name === "CommunicationCoreM4ValidationError") {
    return false;
  }
  return true;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
