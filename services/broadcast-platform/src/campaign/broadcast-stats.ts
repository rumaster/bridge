import { MESSAGE_STATUS } from "../../../../packages/contracts/message-model/index.js";

/**
 * Сбор статистики выполнения кампании `broadcast_stats` (ТЗ §14.8, мастер §4.6).
 *
 * Агрегаты выводятся из фактических статусов сообщений ядра (`messages.status`),
 * связанных через `broadcast_messages`. Соответствие статусов ядра и счётчиков:
 *   - **prepared** — сколько C1-черновиков сформировано (передано в ядро);
 *   - **sent**     — сообщение принято единым механизмом ядра к доставке
 *                    (`status` = `sent` или `delivered`);
 *   - **delivered**— доставка подтверждена (`status` = `delivered`);
 *   - **failed**   — доставка провалена (`status` = `failed`).
 *
 * Инварианты (совпадают с валидатором C8 `stats`): `delivered <= sent <= prepared`
 * и `delivered + failed <= sent`. Пропущенные получатели (несовместимый канал)
 * не формируют сообщение и учитываются отдельно (`skipped`), не входя в `prepared`.
 */

export function createBroadcastStats({ now = () => new Date().toISOString() } = {}) {
  const counters = {
    prepared: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
  };
  let updatedAt = now();

  function touch(occurredAt) {
    updatedAt = occurredAt ?? now();
  }

  return {
    /** Сообщение сформировано и передано в ядро. */
    markPrepared(occurredAt?: string) {
      counters.prepared += 1;
      touch(occurredAt);
    },

    /** Получатель пропущен (несовместимый канал) — сообщение не формировалось. */
    markSkipped(occurredAt?: string) {
      counters.skipped += 1;
      touch(occurredAt);
    },

    /**
     * Учитывает итоговый статус сообщения ядра для одного получателя.
     * @param {string} status Значение `messages.status` (C1).
     */
    recordStatus(status, occurredAt?: string) {
      switch (status) {
        case MESSAGE_STATUS.DELIVERED:
          counters.sent += 1;
          counters.delivered += 1;
          break;
        case MESSAGE_STATUS.SENT:
          counters.sent += 1;
          break;
        case MESSAGE_STATUS.FAILED:
          counters.failed += 1;
          break;
        default:
          // routed/received — сообщение ещё в пути; в агрегаты не попадает.
          break;
      }
      touch(occurredAt);
    },

    snapshot() {
      return {
        prepared: counters.prepared,
        sent: counters.sent,
        delivered: counters.delivered,
        failed: counters.failed,
        updated_at: updatedAt,
      };
    },

    /** Диагностический счётчик пропущенных получателей (вне C8 `stats`). */
    skipped() {
      return counters.skipped;
    },
  };
}
