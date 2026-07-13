import type {
  AttachmentSweepOptions,
  AttachmentSweepResult,
  EdgeAttachmentStore,
} from "./edge-attachment-store.js";

/**
 * Периодический сборщик мусора байтов вложений на RF-томе Edge (закрывает
 * техдолг `docs/plan/email-channel-production.md` §Follow-up п.1: файлы в
 * `EMAIL_ATTACHMENT_STORAGE_DIR` раньше не удалялись никогда — том рос
 * безгранично).
 *
 * MVP-политика — **retention по TTL** от времени записи объекта (mtime файла
 * байтов). Сборщик живёт на Edge (у него доступ к тому) и вызывает
 * {@link EdgeAttachmentStore.sweep} по таймеру. Дедуп по content-hash учтён на
 * уровне свипа: удалённый объект детерминированно пересоздастся при следующем
 * письме с теми же байтами, а точечная защита «живых» ссылок подключается через
 * `isLive` (см. {@link AttachmentSweepOptions.isLive}) — точка расширения под
 * будущий GC-по-ссылкам (список живых `storage_ref` с App-стороны через
 * control-plane).
 *
 * Таймер `unref`-ается: GC не держит процесс живым. Свипы не наслаиваются
 * (`inflight`-гард) — если предыдущий ещё идёт (большой том), тик пропускается.
 */

export interface EdgeAttachmentGcOptions {
  /** Хранилище со свипом (файловый том RF или совместимая реализация). */
  store: Pick<EdgeAttachmentStore, "sweep">;
  /** TTL объектов (мс). Объект старше TTL — кандидат на удаление. */
  ttlMs: number;
  /** Период запуска свипа (мс). По умолчанию 6 часов. */
  intervalMs?: number;
  /** Защита «живых» ссылок; пробрасывается в {@link AttachmentSweepOptions.isLive}. */
  isLive?: AttachmentSweepOptions["isLive"];
  /** Источник времени (мс от эпохи) для сравнения TTL; по умолчанию `Date.now`. */
  now?: () => number;
  logger?: any;
}

export function createEdgeAttachmentGc({
  store,
  ttlMs,
  intervalMs = 6 * 60 * 60 * 1000,
  isLive,
  now = () => Date.now(),
  logger = console,
}: EdgeAttachmentGcOptions) {
  if (!store || typeof store.sweep !== "function") {
    throw new TypeError("store with sweep() is required for attachment GC");
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be a positive number for attachment GC");
  }

  const metrics = {
    sweeps_total: 0,
    sweep_failures_total: 0,
    scanned_total: 0,
    deleted_total: 0,
    kept_total: 0,
    reclaimed_bytes_total: 0,
    delete_errors_total: 0,
    last_deleted: 0,
    last_reclaimed_bytes: 0,
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let inflight = false;

  async function sweepOnce(): Promise<AttachmentSweepResult | undefined> {
    if (inflight) {
      return undefined;
    }
    inflight = true;
    try {
      const result = await store.sweep({ ttlMs, now: now(), isLive });
      metrics.sweeps_total += 1;
      metrics.scanned_total += result.scanned;
      metrics.deleted_total += result.deleted;
      metrics.kept_total += result.kept;
      metrics.reclaimed_bytes_total += result.reclaimedBytes;
      metrics.delete_errors_total += result.errors;
      metrics.last_deleted = result.deleted;
      metrics.last_reclaimed_bytes = result.reclaimedBytes;
      if (result.deleted > 0 || result.errors > 0) {
        logger?.info?.("Edge attachment GC swept RF volume", {
          scanned: result.scanned,
          deleted: result.deleted,
          kept: result.kept,
          reclaimed_bytes: result.reclaimedBytes,
          errors: result.errors,
        });
      }
      return result;
    } catch (error) {
      metrics.sweep_failures_total += 1;
      logger?.error?.("Edge attachment GC sweep failed", { error: describe(error) });
      return undefined;
    } finally {
      inflight = false;
    }
  }

  return {
    /** Прогоняет один свип немедленно (для тестов/ручного вызова). */
    sweepOnce,

    start(): void {
      if (running) {
        return;
      }
      running = true;
      timer = setInterval(() => void sweepOnce(), intervalMs);
      timer.unref?.();
      logger?.info?.("Edge attachment GC started", {
        ttl_ms: ttlMs,
        interval_ms: intervalMs,
      });
    },

    stop(): void {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
