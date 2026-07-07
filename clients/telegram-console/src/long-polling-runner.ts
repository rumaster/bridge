const DEFAULT_ALLOWED_UPDATES = Object.freeze(["message", "callback_query"]);

export function createTelegramLongPollingRunner({
  telegramApi,
  router,
  pollTimeoutSeconds = 30,
  allowedUpdates = DEFAULT_ALLOWED_UPDATES,
  retryDelayMs = 1_000,
  sleep = defaultSleep,
  logger = console,
}: any = {}) {
  if (!telegramApi || typeof telegramApi.getUpdates !== "function") {
    throw new TypeError("telegramApi with getUpdates is required");
  }
  if (!router || typeof router.handleUpdate !== "function") {
    throw new TypeError("router with handleUpdate is required");
  }

  let nextOffset;
  let stopped = false;
  const metrics = {
    polls_total: 0,
    updates_total: 0,
    failed_polls_total: 0,
    handled_errors_total: 0,
  };

  return {
    async pollOnce() {
      metrics.polls_total += 1;
      const updates = await telegramApi.getUpdates({
        offset: nextOffset,
        timeout: pollTimeoutSeconds,
        allowed_updates: [...allowedUpdates],
      });

      for (const update of updates) {
        try {
          await router.handleUpdate(update);
        } catch (error) {
          metrics.handled_errors_total += 1;
          logger?.error?.("Telegram Console update handling failed", {
            update_id: update.update_id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (Number.isInteger(update.update_id)) {
            nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
          }
        }
      }

      metrics.updates_total += updates.length;
      return updates.length;
    },

    async run() {
      logger?.info?.("Telegram Console long polling started", {
        pollTimeoutSeconds,
        allowedUpdates,
      });

      while (!stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          metrics.failed_polls_total += 1;
          logger?.error?.("Telegram Console poll failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(retryDelayMs);
        }
      }
    },

    stop() {
      stopped = true;
    },

    getMetrics() {
      return { ...metrics, next_offset: nextOffset ?? null };
    },
  };
}

function defaultSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
