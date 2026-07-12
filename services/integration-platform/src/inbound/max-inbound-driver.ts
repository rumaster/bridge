/**
 * Входящий драйвер MAX (Этап M3, docs/plan/max-channel-production.md, закрывает
 * MG-6/MG-7). App-side по образцу Telegram (вариант getUpdates long-poll); перенос
 * на Edge — Этап M4.
 *
 * Обязанности:
 *  1. Реестр каналов — из backend `GET /internal/channels?channel_type=max`
 *     (`listChannels`) при старте и периодически. Один канал = одна организация и
 *     свой marker (изоляция мультитенантности).
 *  2. Резолв токена per-channel — тем же механизмом, что egress M2 (`resolveToken`,
 *     backend secret S2S). Нет токена → канал пропускается.
 *  3. Приём — подставляет `organization_id`/`channel_id`/`message_id` в payload и
 *     вызывает `publishIncoming` (MAX-адаптер `buildIngress` → ядро).
 *  4. Дедуп/идемпотентность — стабильный `message_id = idempotency_key =
 *     UUID(channel_id + mid)`. Повтор сообщения (переигранный marker) не двоит
 *     запись (acceptIngress идемпотентен по message.id).
 *
 * Отличие от Telegram: курсор — **marker** (батч-уровень, из ответа `getUpdates`),
 * а не offset per-update. При retryable-сбое публикации marker НЕ двигается — весь
 * батч переопрашивается, уже опубликованные дедуплицируются в ядре.
 *
 * Маппинг отправителя (`conversation_ref = recipient.chat_id`,
 * `sender_ref = sender.user_id`) делает `max-adapter.normalizeIncomingPayload`.
 */

import { stableMaxMessageId } from "./ids.js";

export interface MaxInboundDriverOptions {
  /** Реестр активных каналов из backend: () => [{channelId, organizationId, config}]. */
  listChannels: (input: { channelType: string }) => Promise<any[]>;
  /** Резолв токена бота организации (M2 secret client). */
  resolveToken: (input: { organizationId?: string; channelType?: string }) => Promise<string | null>;
  /**
   * Публикация нормализованного inbound. Контракт ошибок: транспортный сбой
   * (ядро/Edge недоступны) → `retryable === true` — драйвер не двигает marker и
   * переотправит батч; прочие ошибки (непригодный апдейт) → пропуск.
   */
  publishIncoming: (payload: any, channel?: RegistryEntry) => Promise<any>;
  /** Фабрика getUpdates-клиента MAX по токену бота. */
  createUpdatesClient: (input: { token: string }) => {
    getUpdates: (params: any) => Promise<{ updates: any[]; marker?: number | null }>;
  };
  channelType?: string;
  pollTimeoutSeconds?: number;
  limit?: number;
  retryDelayMs?: number;
  pollIntervalMs?: number;
  logger?: any;
  sleep?: (ms: number) => Promise<void>;
}

interface RegistryEntry {
  channelId: string;
  organizationId: string;
  config: Record<string, unknown>;
  marker?: number | null;
}

export function createMaxInboundDriver({
  listChannels,
  resolveToken,
  publishIncoming,
  createUpdatesClient,
  channelType = "max",
  pollTimeoutSeconds = 30,
  limit,
  retryDelayMs = 1_000,
  pollIntervalMs = 0,
  logger = console,
  sleep = defaultSleep,
}: MaxInboundDriverOptions) {
  if (typeof listChannels !== "function") {
    throw new TypeError("listChannels is required");
  }
  if (typeof resolveToken !== "function") {
    throw new TypeError("resolveToken is required");
  }
  if (typeof publishIncoming !== "function") {
    throw new TypeError("publishIncoming is required");
  }
  if (typeof createUpdatesClient !== "function") {
    throw new TypeError("createUpdatesClient is required");
  }

  const registry = new Map<string, RegistryEntry>();
  const clientsByToken = new Map<
    string,
    { getUpdates: (params: any) => Promise<{ updates: any[]; marker?: number | null }> }
  >();
  const channelLoops = new Map<string, { stop(): void }>();
  let running = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const metrics = {
    channels_registered: 0,
    refreshes_total: 0,
    refresh_failures_total: 0,
    updates_received_total: 0,
    ingress_published_total: 0,
    ingress_skipped_total: 0,
    publish_retry_total: 0,
    poll_failures_total: 0,
    missing_token_total: 0,
  };

  async function refreshChannels(): Promise<number> {
    metrics.refreshes_total += 1;
    let channels: any[];
    try {
      channels = await listChannels({ channelType });
    } catch (error) {
      metrics.refresh_failures_total += 1;
      logger?.error?.("MAX inbound channel refresh failed", { error: describe(error) });
      return registry.size;
    }

    const seen = new Set<string>();
    for (const channel of channels ?? []) {
      const channelId = channel?.channelId ?? channel?.channel_id;
      const organizationId = channel?.organizationId ?? channel?.organization_id;
      if (!channelId || !organizationId) {
        continue;
      }
      seen.add(channelId);
      const existing = registry.get(channelId);
      if (existing) {
        // Сохраняем marker уже работающего поллера, обновляем маппинг/конфиг.
        existing.organizationId = organizationId;
        existing.config = channel.config ?? existing.config;
      } else {
        registry.set(channelId, {
          channelId,
          organizationId,
          config: channel.config ?? {},
          marker: undefined,
        });
      }
    }

    for (const channelId of [...registry.keys()]) {
      if (!seen.has(channelId)) {
        registry.delete(channelId);
      }
    }

    metrics.channels_registered = registry.size;
    return registry.size;
  }

  function getUpdatesClient(token: string) {
    let client = clientsByToken.get(token);
    if (!client) {
      client = createUpdatesClient({ token });
      clientsByToken.set(token, client);
    }
    return client;
  }

  async function pollChannelOnce(
    channelId: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<number> {
    const channel = registry.get(channelId);
    if (!channel) {
      return 0;
    }

    const token = await resolveToken({ organizationId: channel.organizationId, channelType });
    if (!token) {
      metrics.missing_token_total += 1;
      logger?.warn?.("No MAX token for inbound channel; skipping poll", {
        channel_id: channelId,
        organization_id: channel.organizationId,
      });
      return 0;
    }

    const client = getUpdatesClient(token);
    const { updates, marker: nextMarker } = await client.getUpdates({
      marker: channel.marker,
      timeout: pollTimeoutSeconds,
      limit,
      signal,
    });

    let published = 0;
    let retryableFailure = false;
    for (const update of updates ?? []) {
      metrics.updates_received_total += 1;
      try {
        await handleUpdate(channel, update);
        published += 1;
      } catch (error) {
        if (isRetryablePublishError(error)) {
          // Транспортный сбой публикации (ядро/Edge недоступны, 5xx): НЕ двигаем
          // marker и прерываем разбор батча — батч переопросится, уже
          // опубликованные дедуплицируются в ядре по message_id (M3/M4).
          metrics.publish_retry_total += 1;
          logger?.warn?.("Ingress publish failed; will retry this batch on next poll", {
            channel_id: channelId,
            error: describe(error),
          });
          retryableFailure = true;
          break;
        }
        // Непригодный апдейт (сервисное событие MAX и т.п. — не проходит
        // нормализацию C2): пропускаем; marker всё равно продвинется после батча.
        metrics.ingress_skipped_total += 1;
        logger?.warn?.("Skipping MAX update that could not be ingested", {
          channel_id: channelId,
          error: describe(error),
        });
      }
    }

    // Двигаем marker только если весь батч обработан без retryable-сбоя.
    if (!retryableFailure && nextMarker !== undefined && nextMarker !== null) {
      channel.marker = nextMarker;
    }

    return published;
  }

  async function handleUpdate(channel: RegistryEntry, update: any): Promise<void> {
    const mid = extractMaxMessageId(update);
    // Стабильный UUID-ключ идемпотентности из mid: повтор сообщения → тот же
    // message_id → acceptIngress не создаёт второе сообщение. Для апдейтов без mid
    // (сервисные) ключ детерминирован, но нормализация всё равно их отклонит.
    const messageId = stableMaxMessageId(channel.channelId, mid ?? fallbackRef(update));
    const payload = {
      ...update,
      organization_id: channel.organizationId,
      channel_id: channel.channelId,
      message_id: messageId,
      idempotency_key: messageId,
    };
    await publishIncoming(payload, channel);
    metrics.ingress_published_total += 1;
  }

  async function pollAllOnce(options: { signal?: AbortSignal } = {}): Promise<number> {
    let total = 0;
    for (const channelId of [...registry.keys()]) {
      try {
        total += await pollChannelOnce(channelId, options);
      } catch (error) {
        metrics.poll_failures_total += 1;
        logger?.error?.("MAX inbound poll failed", {
          channel_id: channelId,
          error: describe(error),
        });
      }
    }
    return total;
  }

  function runChannelLoop(channelId: string): { stop(): void } {
    const controller = new AbortController();
    let stopped = false;

    void (async () => {
      while (running && !stopped && registry.has(channelId)) {
        try {
          await pollChannelOnce(channelId, { signal: controller.signal });
          if (pollIntervalMs > 0) {
            await sleep(pollIntervalMs);
          }
        } catch (error) {
          if (stopped) {
            break;
          }
          metrics.poll_failures_total += 1;
          logger?.error?.("MAX inbound poll failed", {
            channel_id: channelId,
            error: describe(error),
          });
          await sleep(retryDelayMs);
        }
      }
    })();

    return {
      stop() {
        stopped = true;
        controller.abort();
      },
    };
  }

  function syncPollers(): void {
    for (const channelId of registry.keys()) {
      if (!channelLoops.has(channelId)) {
        channelLoops.set(channelId, runChannelLoop(channelId));
      }
    }
    for (const [channelId, loop] of [...channelLoops.entries()]) {
      if (!registry.has(channelId)) {
        loop.stop();
        channelLoops.delete(channelId);
      }
    }
  }

  return {
    refreshChannels,
    pollChannelOnce,
    pollAllOnce,

    async start({ refreshIntervalMs = 30_000 }: { refreshIntervalMs?: number } = {}): Promise<void> {
      if (running) {
        return;
      }
      running = true;
      await refreshChannels();
      syncPollers();
      logger?.info?.("MAX inbound driver started", {
        channels: registry.size,
        pollTimeoutSeconds,
      });

      refreshTimer = setInterval(() => {
        void (async () => {
          await refreshChannels();
          if (running) {
            syncPollers();
          }
        })();
      }, refreshIntervalMs);
      refreshTimer.unref?.();
    },

    stop(): void {
      running = false;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
      for (const loop of channelLoops.values()) {
        loop.stop();
      }
      channelLoops.clear();
    },

    getMetrics() {
      return { ...metrics };
    },

    getRegistry(): RegistryEntry[] {
      return [...registry.values()].map((entry) => ({ ...entry }));
    },
  };
}

/** Извлекает id входящего MAX-сообщения (message_created): `message.body.mid`. */
function extractMaxMessageId(update: any): number | string | undefined {
  const mid = update?.message?.body?.mid ?? update?.message?.mid ?? update?.body?.mid;
  return typeof mid === "string" || typeof mid === "number" ? mid : undefined;
}

/** Детерминированный запасной ключ для апдейтов без mid (будут отклонены). */
function fallbackRef(update: any): string {
  return `${update?.update_type ?? "update"}:${update?.timestamp ?? "0"}`;
}

function isRetryablePublishError(error: any): boolean {
  return Boolean(error) && error.retryable === true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
