import { randomUUID } from "node:crypto";

import { ChannelDeliveryError } from "./errors.mjs";

/**
 * Мок внешнего API канала — фасад доставки для тестов и локального запуска
 * (ТЗ §26.3: реальные внешние сервисы в CI не вызываются).
 *
 * Ключевое свойство — **идемпотентность по `idempotency_key`** (= `message_id`,
 * ТЗ §11.12): повторная доставка с уже обработанным ключом НЕ создаёт второе
 * внешнее сообщение, а возвращает результат первой доставки (`duplicate: true`).
 * Это обеспечивает совместимость at-least-once ретраев с отсутствием дублей.
 *
 * Инъекция сбоев (`outcomes`) моделирует ошибки внешнего API: на каждый вызов
 * доставки по ключу берётся следующая директива:
 *   - "ok" (или отсутствие директивы) — успешная доставка;
 *   - { status, retryable, message } — бросить ошибку ДО записи (сообщение не
 *     создаётся, кандидат на ретрай);
 *   - "lost-ack" — записать сообщение, затем бросить повторяемую ошибку
 *     (ack потерян): ретрай попадёт в идемпотентный отбой без дубля.
 */
export function createMockExternalChannel({
  now = () => new Date().toISOString(),
  outcomes = {},
} = {}) {
  const externalMessages = new Map(); // idempotency_key -> external message
  const attemptsByKey = new Map(); // idempotency_key -> attempt count
  const pending = new Map(); // idempotency_key -> remaining directives
  const log = [];

  for (const [key, directives] of Object.entries(outcomes)) {
    pending.set(key, [...toArray(directives)]);
  }

  function nextDirective(key) {
    const queue = pending.get(key);
    if (!queue || queue.length === 0) {
      return "ok";
    }
    return queue.shift();
  }

  return {
    /** Сколько внешних сообщений реально создано (для проверки отсутствия дублей). */
    get deliveredCount() {
      return externalMessages.size;
    },

    /** Полный журнал вызовов доставки (включая дубли и сбои). */
    getLog() {
      return log.map((entry) => ({ ...entry }));
    },

    getExternalMessages() {
      return [...externalMessages.values()].map((message) => ({ ...message }));
    },

    attemptsFor(idempotencyKey) {
      return attemptsByKey.get(idempotencyKey) ?? 0;
    },

    async deliver({ idempotencyKey, channelType, message } = {}) {
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
        throw new TypeError("idempotencyKey must be a non-empty string");
      }

      const attemptCount = (attemptsByKey.get(idempotencyKey) ?? 0) + 1;
      attemptsByKey.set(idempotencyKey, attemptCount);

      // Идемпотентный отбой: ключ уже доставлен — второе внешнее сообщение
      // не создаётся (ТЗ §11.12).
      if (externalMessages.has(idempotencyKey)) {
        const existing = externalMessages.get(idempotencyKey);
        log.push({ idempotencyKey, attempt: attemptCount, outcome: "duplicate" });
        return {
          delivered: true,
          duplicate: true,
          external_message_id: existing.external_message_id,
          delivered_at: existing.delivered_at,
        };
      }

      const directive = nextDirective(idempotencyKey);

      if (isFailureDirective(directive)) {
        log.push({ idempotencyKey, attempt: attemptCount, outcome: "failed" });
        throw failureFromDirective(directive);
      }

      const externalMessageId = `ext-${channelType ?? "channel"}-${randomUUID()}`;
      const record = {
        idempotency_key: idempotencyKey,
        external_message_id: externalMessageId,
        channel_type: channelType,
        message,
        delivered_at: now(),
      };

      if (directive === "lost-ack") {
        // Сообщение записано во внешнем канале, но подтверждение «потеряно»:
        // вызывающая сторона получит повторяемую ошибку и повторит доставку.
        externalMessages.set(idempotencyKey, record);
        log.push({ idempotencyKey, attempt: attemptCount, outcome: "lost-ack" });
        throw new ChannelDeliveryError("external ack lost after delivery", {
          code: "ECONNRESET",
          retryable: true,
          category: "network",
        });
      }

      externalMessages.set(idempotencyKey, record);
      log.push({ idempotencyKey, attempt: attemptCount, outcome: "delivered" });
      return {
        delivered: true,
        duplicate: false,
        external_message_id: externalMessageId,
        delivered_at: record.delivered_at,
      };
    },
  };
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function isFailureDirective(directive) {
  return (
    directive !== "ok" &&
    directive !== "lost-ack" &&
    directive !== null &&
    typeof directive === "object"
  );
}

function failureFromDirective(directive) {
  return new ChannelDeliveryError(directive.message ?? "external delivery failed", {
    status: directive.status,
    code: directive.code,
    retryable: directive.retryable,
    category: directive.category,
    retryAfterMs: directive.retryAfterMs,
  });
}
