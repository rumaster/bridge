/**
 * Наблюдаемость ёмкости RF-буфера Edge (Этап M4, §7.14).
 *
 * RF-буфер ([`edge-message-buffer.ts`](./edge-message-buffer.ts)) уже эмитит
 * notify-события при достижении high-watermark и при исчерпании ёмкости, но в
 * проде эти события никуда не были подключены: `createPostgresBufferStore`
 * поднимал стор БЕЗ `capacity`/`notify` (ёмкость = Infinity), поэтому
 * переполнение RF-буфера — прямая потеря RPO (§7.14) — оставалось невидимым в
 * логах и метриках. На стенде capacity=Infinity сохраняется (поведение не
 * меняется), но для боевого RPO ёмкость задаётся `EDGE_BUFFER_CAPACITY`.
 *
 * Этот модуль связывает notify-хук стора с логами:
 *   - {@link resolveBufferCapacityOptions} — читает env `EDGE_BUFFER_CAPACITY` и
 *     `EDGE_BUFFER_HIGH_WATERMARK_RATIO` (дефолты Infinity / 0.8);
 *   - {@link createBufferCapacityNotifier} — notify-обработчик, логирующий
 *     capacity high-watermark (warn / critical→error) и exhausted (error).
 *
 * TTL-события (`edge_buffer_ttl_expired`) здесь СОЗНАТЕЛЬНО не логируются: их с
 * дедупом по `idempotency_key` уже разбирает edge-cluster (drainPending), иначе
 * один и тот же lost-message спамил бы лог на каждом дренаже.
 */

export interface BufferCapacityRuntimeOptions {
  /** Максимум записей RF-буфера; Infinity = без лимита (поведение стенда). */
  capacity: number;
  /** Доля ёмкости, с которой начинается high-watermark алерт (0, 1]. */
  highWatermarkRatio: number;
}

const DEFAULT_HIGH_WATERMARK_RATIO = 0.8;

/**
 * Читает конфигурацию ёмкости RF-буфера из окружения. Некорректные значения
 * тихо откатываются к дефолтам (Infinity / 0.8), чтобы битый env не ронял
 * рантайм Edge — приёмный контур важнее алертинга ёмкости.
 */
export function resolveBufferCapacityOptions(
  env: Record<string, string | undefined> = {},
): BufferCapacityRuntimeOptions {
  return {
    capacity: parseCapacity(env.EDGE_BUFFER_CAPACITY),
    highWatermarkRatio: parseRatio(env.EDGE_BUFFER_HIGH_WATERMARK_RATIO),
  };
}

function parseCapacity(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return Number.POSITIVE_INFINITY;
  }
  const value = raw.trim().toLowerCase();
  if (value === "infinity" || value === "inf" || value === "0") {
    // "0" трактуем как «без лимита» (а не нулевую ёмкость, которая бессмысленна).
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

function parseRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HIGH_WATERMARK_RATIO;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : DEFAULT_HIGH_WATERMARK_RATIO;
}

export interface BufferCapacityLogger {
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
}

export interface CreateBufferCapacityNotifierOptions {
  logger?: BufferCapacityLogger;
}

/**
 * Возвращает notify-обработчик для RF-буфера, логирующий capacity-события.
 * high-watermark severity `warning` → warn, `critical` → error; исчерпание
 * ёмкости → error. Прочие типы событий игнорируются (см. заметку про TTL выше).
 */
export function createBufferCapacityNotifier({
  logger = console,
}: CreateBufferCapacityNotifierOptions = {}) {
  return function notify(event: any): void {
    if (!event || typeof event !== "object") {
      return;
    }
    switch (event.type) {
      case "edge_buffer_capacity_high_watermark": {
        const emit = event.severity === "critical" ? logger.error : logger.warn;
        emit?.call(
          logger,
          "RF-буфер Edge: достигнут high-watermark ёмкости (риск backpressure и потери RPO)",
          {
            severity: event.severity,
            size: event.size,
            capacity: event.capacity,
            high_watermark: event.high_watermark,
            usage_ratio: event.usage_ratio,
          },
        );
        break;
      }
      case "edge_buffer_capacity_exhausted": {
        logger.error?.call(
          logger,
          "RF-буфер Edge: ёмкость исчерпана — приём под backpressure, RPO под угрозой",
          {
            endpoint_id: event.endpoint_id,
            sequence_number: event.sequence_number,
            idempotency_key: event.idempotency_key,
            size: event.size,
            capacity: event.capacity,
          },
        );
        break;
      }
      default:
        // edge_buffer_ttl_expired и прочее — не наша ответственность (см. модуль-док).
        break;
    }
  };
}
