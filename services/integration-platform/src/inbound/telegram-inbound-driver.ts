/**
 * Входящий драйвер Telegram (Этап T3, docs/plan/telegram-channel-production.md).
 *
 * Решение по способу приёма — **вариант P (getUpdates long-poll)**: на каждый
 * подключённый telegram-канал поднимается независимый поллер `getUpdates` с
 * токеном организации. Не требует публичного HTTPS-URL и `setWebhook`, легко
 * тестируется; webhook (вариант W) остаётся альтернативой для прод (см. план).
 *
 * Обязанности драйвера:
 *  1. Реестр каналов — наполняется из backend `GET /internal/channels?channel_type=telegram`
 *     (`listChannels`) при старте и периодически. Один канал = одна организация и
 *     свой оффсет getUpdates (изоляция мультитенантности).
 *  2. Резолв токена per-channel — через тот же механизм, что и egress T2
 *     (`resolveToken`, backend secret S2S). Нет токена → канал пропускается.
 *  3. Приём апдейтов — подставляет `organization_id`/`channel_id` в payload и
 *     вызывает `publishIncoming` (telegram-адаптер `publishIncomingMessage`,
 *     нормализация в C2.IngressMessage → backend `acceptIngress`).
 *  4. Дедуп/идемпотентность — стабильный `message_id = idempotency_key =
 *     tg-<channel_id>-<update_id>`. Повтор апдейта не двоит сообщение
 *     (`acceptIngress` идемпотентен по message.id). Оффсеты — per-channel:
 *     подтверждаются передачей `offset = update_id + 1` в следующий getUpdates.
 *
 * Маппинг отправителя (`conversation_ref = chat.id`, `sender_ref = from.id`) уже
 * делает `telegram-adapter.normalizeIncomingPayload`; драйвер лишь прокидывает
 * сырой апдейт вместе с organization_id/channel_id.
 */

import { stableTelegramMessageId } from "./ids.js";

const DEFAULT_ALLOWED_UPDATES = Object.freeze(["message", "edited_message"]);

export interface TelegramInboundDriverOptions {
  /** Реестр активных каналов из backend: () => [{channelId, organizationId, config}]. */
  listChannels: (input: { channelType: string }) => Promise<any[]>;
  /** Резолв токена бота организации (T2 secret client). */
  resolveToken: (input: { organizationId?: string; channelType?: string }) => Promise<string | null>;
  /**
   * Публикация нормализованного inbound. Получает сырой payload и канал (для
   * выбора маршрута core/Edge, T5). Контракт ошибок: транспортный сбой (ядро/Edge
   * недоступны) бросает ошибку с `retryable === true` — драйвер не двигает оффсет
   * и переотправит; прочие ошибки (непригодный апдейт) → пропуск с продвижением.
   */
  publishIncoming: (payload: any, channel?: RegistryEntry) => Promise<any>;
  /** Фабрика getUpdates-клиента по токену бота. */
  createUpdatesClient: (input: { token: string }) => { getUpdates: (params: any) => Promise<any[]> };
  channelType?: string;
  pollTimeoutSeconds?: number;
  allowedUpdates?: readonly string[];
  retryDelayMs?: number;
  pollIntervalMs?: number;
  logger?: any;
  sleep?: (ms: number) => Promise<void>;
}

interface RegistryEntry {
  channelId: string;
  organizationId: string;
  config: Record<string, unknown>;
  offset?: number;
}

export function createTelegramInboundDriver({
  listChannels,
  resolveToken,
  publishIncoming,
  createUpdatesClient,
  channelType = "telegram",
  pollTimeoutSeconds = 30,
  allowedUpdates = DEFAULT_ALLOWED_UPDATES,
  retryDelayMs = 1_000,
  pollIntervalMs = 0,
  logger = console,
  sleep = defaultSleep,
}: TelegramInboundDriverOptions) {
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
  const clientsByToken = new Map<string, { getUpdates: (params: any) => Promise<any[]> }>();
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
      logger?.error?.("Telegram inbound channel refresh failed", { error: describe(error) });
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
        // Сохраняем оффсет уже работающего поллера, обновляем маппинг/конфиг.
        existing.organizationId = organizationId;
        existing.config = channel.config ?? existing.config;
      } else {
        registry.set(channelId, {
          channelId,
          organizationId,
          config: channel.config ?? {},
          offset: undefined,
        });
      }
    }

    // Отключённые каналы удаляем из реестра (их поллеры остановит syncPollers).
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

  async function pollChannelOnce(channelId: string, { signal }: { signal?: AbortSignal } = {}): Promise<number> {
    const channel = registry.get(channelId);
    if (!channel) {
      return 0;
    }

    const token = await resolveToken({ organizationId: channel.organizationId, channelType });
    if (!token) {
      metrics.missing_token_total += 1;
      logger?.warn?.("No Telegram token for inbound channel; skipping poll", {
        channel_id: channelId,
        organization_id: channel.organizationId,
      });
      return 0;
    }

    const client = getUpdatesClient(token);
    const updates = await client.getUpdates({
      offset: channel.offset,
      timeout: pollTimeoutSeconds,
      allowedUpdates: [...allowedUpdates],
      signal,
    });

    let published = 0;
    for (const update of updates ?? []) {
      metrics.updates_received_total += 1;
      try {
        await handleUpdate(channel, update);
        published += 1;
      } catch (error) {
        if (isRetryablePublishError(error)) {
          // Транспортный сбой публикации (ядро/Edge недоступны, 5xx): НЕ двигаем
          // оффсет и прерываем разбор батча — апдейт переотправится на следующем
          // поллинге (RF-first: сообщение не теряется, T5 задача 4).
          metrics.publish_retry_total += 1;
          logger?.warn?.("Ingress publish failed; will retry this update on next poll", {
            channel_id: channelId,
            update_id: update?.update_id,
            error: describe(error),
          });
          break;
        }
        // Непригодный апдейт (сервисное событие, callback_query и т.п. — не
        // проходит нормализацию C2) или неожиданная ошибка: пропускаем и двигаем
        // оффсет, чтобы «ядовитый» апдейт не блокировал очередь.
        metrics.ingress_skipped_total += 1;
        logger?.warn?.("Skipping Telegram update that could not be ingested", {
          channel_id: channelId,
          update_id: update?.update_id,
          error: describe(error),
        });
      }

      // Оффсет двигаем только для успеха/пропуска; на retryable-сбое мы уже
      // сделали break выше, оставив оффсет на упавшем апдейте.
      if (Number.isInteger(update?.update_id)) {
        channel.offset = Math.max(channel.offset ?? 0, update.update_id + 1);
      }
    }

    return published;
  }

  async function handleUpdate(channel: RegistryEntry, update: any): Promise<void> {
    const updateId = update?.update_id;
    // Стабильный UUID-ключ идемпотентности: повтор апдейта → тот же message_id →
    // acceptIngress не создаёт второе сообщение. UUID (а не `tg-...`) обязателен —
    // ядро принимает message.id только как строгий UUID (C1/C2 UUID_PATTERN).
    const messageId = stableTelegramMessageId(channel.channelId, updateId);
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
        logger?.error?.("Telegram inbound poll failed", {
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
          logger?.error?.("Telegram inbound poll failed", {
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
      logger?.info?.("Telegram inbound driver started", {
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
      // Не держим event loop открытым только ради таймера рефреша.
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

function isRetryablePublishError(error: any): boolean {
  return Boolean(error) && error.retryable === true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
