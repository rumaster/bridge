import { NonIngestibleMaxUpdateError, buildMaxIngress } from "./edge-max-ingress.js";

/**
 * Входящий MAX-драйвер на Edge Gateway (Этап M4 плана
 * `docs/plan/max-channel-production.md`, закрывает MG-8 по входящему направлению).
 *
 * По требованию «бот max на edge» MAX — Edge-owned (как email): getUpdates идёт
 * **на Edge**, а не app-side (Этап M3). Драйвер:
 *  1. Реестр max-каналов — из `listChannels` (при старте и периодически).
 *  2. Резолв кред per-organization — из локального кэша control-plane
 *     (`getChannelCredentials(org,"max")`); нет токена → канал пропускается.
 *  3. Приём — `createUpdatesClient` (инъектируемый getUpdates-клиент MAX Bot API)
 *     отдаёт батч `{ updates, marker }` по курсору marker; каждый апдейт
 *     нормализуется {@link buildMaxIngress} в конверт C2.IngressMessage.
 *  4. RF-first публикация — `ingest` (EdgeCluster.ingest): апдейт фиксируется в
 *     RF-буфере ДО пересылки в ядро через туннель (не теряется при разрыве).
 *  5. Дедуп/идемпотентность — по `mid` (per-channel `seen`) и сквозным
 *     `idempotency_key` = стабильный UUID(channel+mid) — в RF-буфере и ядре.
 *
 * Курсор — **marker** (батч-уровень из ответа `getUpdates`): при retryable-сбое
 * приёма marker НЕ двигается, батч переопрашивается (уже принятые — в `seen`).
 */

export interface EdgeMaxChannel {
  channelId: string;
  organizationId: string;
  config?: Record<string, unknown>;
}

export interface EdgeMaxUpdatesClient {
  getUpdates(input: {
    marker?: number | null;
    signal?: AbortSignal;
  }): Promise<{ updates: any[]; marker?: number | null }>;
}

export interface EdgeMaxInboundDriverOptions {
  /** Реестр активных max-каналов: () => [{channelId, organizationId, config}]. */
  listChannels: (input: { channelType: string }) => Promise<EdgeMaxChannel[]>;
  /** Резолв кред (токена) MAX-канала организации (из control-plane кэша Edge). */
  resolveCredentials: (input: {
    organizationId: string;
    channelId: string;
  }) => unknown | Promise<unknown>;
  /** Фабрика getUpdates-клиента MAX Bot API по кредам канала. */
  createUpdatesClient: (input: { credentials: unknown; channel: EdgeMaxChannel }) => EdgeMaxUpdatesClient;
  /** RF-first приём (EdgeCluster.ingest). Бросок → повтор (marker не двигается). */
  ingest: (ingressBody: unknown) => Promise<unknown>;
  now?: () => string;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  logger?: any;
  sleep?: (ms: number) => Promise<void>;
  seenLimit?: number;
}

interface RegistryEntry {
  channelId: string;
  organizationId: string;
  config: Record<string, unknown>;
  marker?: number | null;
  seen: Set<string>;
}

export function createEdgeMaxInboundDriver({
  listChannels,
  resolveCredentials,
  createUpdatesClient,
  ingest,
  now = () => new Date().toISOString(),
  pollIntervalMs = 0,
  retryDelayMs = 1_000,
  logger = console,
  sleep = defaultSleep,
  seenLimit = 5_000,
}: EdgeMaxInboundDriverOptions) {
  for (const [name, value] of Object.entries({ listChannels, resolveCredentials, createUpdatesClient, ingest })) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} is required`);
    }
  }

  const channelType = "max";
  const registry = new Map<string, RegistryEntry>();
  const clients = new Map<string, EdgeMaxUpdatesClient>();
  const channelLoops = new Map<string, { stop(): void }>();
  let running = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const metrics = {
    channels_registered: 0,
    refreshes_total: 0,
    refresh_failures_total: 0,
    updates_fetched_total: 0,
    ingested_total: 0,
    skipped_total: 0,
    duplicate_total: 0,
    ingest_retry_total: 0,
    missing_credentials_total: 0,
    poll_failures_total: 0,
  };

  async function refreshChannels(): Promise<number> {
    metrics.refreshes_total += 1;
    let channels: EdgeMaxChannel[];
    try {
      channels = await listChannels({ channelType });
    } catch (error) {
      metrics.refresh_failures_total += 1;
      logger?.error?.("Edge MAX channel refresh failed", { error: describe(error) });
      return registry.size;
    }

    const seenChannels = new Set<string>();
    for (const channel of channels ?? []) {
      const channelId = (channel as any)?.channelId ?? (channel as any)?.channel_id;
      const organizationId = (channel as any)?.organizationId ?? (channel as any)?.organization_id;
      if (!channelId || !organizationId) {
        continue;
      }
      seenChannels.add(channelId);
      const existing = registry.get(channelId);
      if (existing) {
        existing.organizationId = organizationId;
        existing.config = channel.config ?? existing.config;
      } else {
        registry.set(channelId, {
          channelId,
          organizationId,
          config: channel.config ?? {},
          marker: undefined,
          seen: new Set<string>(),
        });
      }
    }

    for (const channelId of [...registry.keys()]) {
      if (!seenChannels.has(channelId)) {
        registry.delete(channelId);
        clients.delete(channelId);
      }
    }

    metrics.channels_registered = registry.size;
    return registry.size;
  }

  function rememberSeen(entry: RegistryEntry, key: string): void {
    entry.seen.add(key);
    if (entry.seen.size > seenLimit) {
      const oldest = entry.seen.values().next().value;
      if (oldest !== undefined) {
        entry.seen.delete(oldest);
      }
    }
  }

  async function pollChannelOnce(
    channelId: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<number> {
    const entry = registry.get(channelId);
    if (!entry) {
      return 0;
    }

    const credentials = await resolveCredentials({
      organizationId: entry.organizationId,
      channelId: entry.channelId,
    });
    if (!credentials) {
      metrics.missing_credentials_total += 1;
      logger?.warn?.("No MAX credentials synced for channel; skipping poll", {
        channel_id: channelId,
        organization_id: entry.organizationId,
      });
      return 0;
    }

    const client = getClient(entry, credentials);
    const { updates, marker: nextMarker } = await client.getUpdates({ marker: entry.marker, signal });

    let ingested = 0;
    let retryableBreak = false;
    for (const update of updates ?? []) {
      metrics.updates_fetched_total += 1;
      const dedupKey = extractMid(update);

      if (dedupKey && entry.seen.has(dedupKey)) {
        metrics.duplicate_total += 1;
        continue;
      }

      let ingressBody: unknown;
      try {
        ingressBody = buildMaxIngress({
          update,
          organizationId: entry.organizationId,
          channelId: entry.channelId,
          now,
        });
      } catch (error) {
        if (error instanceof NonIngestibleMaxUpdateError) {
          // Непригодный апдейт (сервисное событие MAX): пропускаем; marker всё
          // равно продвинется после батча (не блокирует очередь).
          metrics.skipped_total += 1;
          logger?.warn?.("Skipping non-ingestible MAX update", {
            channel_id: channelId,
            error: describe(error),
          });
          if (dedupKey) {
            rememberSeen(entry, dedupKey);
          }
          continue;
        }
        throw error;
      }

      try {
        await ingest(ingressBody);
      } catch (error) {
        // Бэкпрешер RF-буфера/сбой приёма: НЕ двигаем marker и прерываем батч —
        // апдейт переопросится на следующем поллинге (RF-first: не теряется).
        metrics.ingest_retry_total += 1;
        logger?.warn?.("Edge ingest failed; will retry this batch on next poll", {
          channel_id: channelId,
          error: describe(error),
        });
        retryableBreak = true;
        break;
      }

      metrics.ingested_total += 1;
      ingested += 1;
      if (dedupKey) {
        rememberSeen(entry, dedupKey);
      }
    }

    // Двигаем marker только если весь батч обработан без retryable-сбоя.
    if (!retryableBreak && nextMarker !== undefined && nextMarker !== null) {
      entry.marker = nextMarker;
    }

    return ingested;
  }

  function getClient(entry: RegistryEntry, credentials: unknown): EdgeMaxUpdatesClient {
    let client = clients.get(entry.channelId);
    if (!client) {
      client = createUpdatesClient({ credentials, channel: entry });
      clients.set(entry.channelId, client);
    }
    return client;
  }

  async function pollAllOnce(options: { signal?: AbortSignal } = {}): Promise<number> {
    let total = 0;
    for (const channelId of [...registry.keys()]) {
      try {
        total += await pollChannelOnce(channelId, options);
      } catch (error) {
        metrics.poll_failures_total += 1;
        logger?.error?.("Edge MAX poll failed", { channel_id: channelId, error: describe(error) });
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
          await sleep(pollIntervalMs);
        } catch (error) {
          if (stopped) {
            break;
          }
          metrics.poll_failures_total += 1;
          logger?.error?.("Edge MAX poll failed", {
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
      logger?.info?.("Edge MAX inbound driver started", { channels: registry.size });

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

    getRegistry(): Array<Omit<RegistryEntry, "seen">> {
      return [...registry.values()].map(({ seen: _seen, ...entry }) => ({ ...entry }));
    },
  };
}

/** Извлекает id входящего MAX-сообщения (message_created): `message.body.mid`. */
function extractMid(update: any): string | undefined {
  const mid = update?.message?.body?.mid ?? update?.message?.mid ?? update?.body?.mid;
  if (typeof mid === "string" && mid.trim() !== "") {
    return mid;
  }
  if (typeof mid === "number" && Number.isFinite(mid)) {
    return String(mid);
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
