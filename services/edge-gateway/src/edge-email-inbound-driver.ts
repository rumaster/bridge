import { NonIngestibleEmailError, buildEmailIngress, type RawEmail } from "./edge-email-ingress.js";

/**
 * Входящий email-драйвер на Edge Gateway (Этап E3 плана
 * `docs/plan/email-channel-production.md`, закрывает G-5/G-9 по входящему
 * направлению).
 *
 * По решению 1 email — Edge-owned: письма клиента забираются по IMAP **на Edge**
 * (а не на app-стороне, как Telegram getUpdates). Драйвер:
 *  1. Реестр email-каналов — из `listChannels` (при старте и периодически).
 *  2. Резолв кред per-organization — из локального кэша control-plane
 *     (Этап E2, `edge-control-plane.getEmailCredentials`); нет кред → канал
 *     пропускается (креды ещё не синхронизированы с app-стороны).
 *  3. Приём — `createMailbox` (инъектируемый IMAP-клиент: IDLE или poll — забота
 *     реализации/боевого daemon) отдаёт новые письма по курсору UID; каждое
 *     нормализуется {@link buildEmailIngress} в конверт C2.IngressMessage.
 *  4. RF-first публикация — `ingest` (EdgeCluster.ingest): письмо фиксируется в
 *     RF-буфере ДО пересылки в ядро через туннель (не теряется при разрыве).
 *  5. Дедуп/идемпотентность — по заголовку `Message-ID` (per-channel `seen`) и,
 *     сквозным `idempotency_key` = стабильный UUID письма — в RF-буфере и ядре.
 *
 * В отличие от Telegram, для email нет прямого app-side пути: публикация ВСЕГДА
 * идёт через Edge (RF-буфер → туннель → CORE_INGRESS_URL).
 */

export interface EdgeEmailChannel {
  channelId: string;
  organizationId: string;
  config?: Record<string, unknown>;
}

export interface EdgeMailbox {
  /** Возвращает новые письма с UID > sinceUid (или все, если sinceUid не задан). */
  fetchNew(input: { sinceUid?: number; signal?: AbortSignal }): Promise<RawEmail[]>;
}

export interface EdgeEmailInboundDriverOptions {
  /** Реестр активных email-каналов: () => [{channelId, organizationId, config}]. */
  listChannels: (input: { channelType: string }) => Promise<EdgeEmailChannel[]>;
  /** Резолв структурных email-кред организации (из control-plane кэша Edge). */
  resolveCredentials: (input: {
    organizationId: string;
    channelId: string;
  }) => unknown | Promise<unknown>;
  /** Фабрика почтового ящика (IMAP-клиент) по кредам канала. */
  createMailbox: (input: { credentials: unknown; channel: EdgeEmailChannel }) => EdgeMailbox;
  /** RF-first приём (EdgeCluster.ingest). Бросок → повтор (курсор не двигается). */
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
  cursorUid?: number;
  seen: Set<string>;
}

export function createEdgeEmailInboundDriver({
  listChannels,
  resolveCredentials,
  createMailbox,
  ingest,
  now = () => new Date().toISOString(),
  pollIntervalMs = 0,
  retryDelayMs = 1_000,
  logger = console,
  sleep = defaultSleep,
  seenLimit = 5_000,
}: EdgeEmailInboundDriverOptions) {
  for (const [name, value] of Object.entries({ listChannels, resolveCredentials, createMailbox, ingest })) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} is required`);
    }
  }

  const channelType = "email";
  const registry = new Map<string, RegistryEntry>();
  const mailboxes = new Map<string, EdgeMailbox>();
  const channelLoops = new Map<string, { stop(): void }>();
  let running = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const metrics = {
    channels_registered: 0,
    refreshes_total: 0,
    refresh_failures_total: 0,
    emails_fetched_total: 0,
    ingested_total: 0,
    skipped_total: 0,
    duplicate_total: 0,
    ingest_retry_total: 0,
    missing_credentials_total: 0,
    poll_failures_total: 0,
  };

  async function refreshChannels(): Promise<number> {
    metrics.refreshes_total += 1;
    let channels: EdgeEmailChannel[];
    try {
      channels = await listChannels({ channelType });
    } catch (error) {
      metrics.refresh_failures_total += 1;
      logger?.error?.("Edge email channel refresh failed", { error: describe(error) });
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
          cursorUid: undefined,
          seen: new Set<string>(),
        });
      }
    }

    for (const channelId of [...registry.keys()]) {
      if (!seenChannels.has(channelId)) {
        registry.delete(channelId);
        mailboxes.delete(channelId);
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
      logger?.warn?.("No email credentials synced for channel; skipping poll", {
        channel_id: channelId,
        organization_id: entry.organizationId,
      });
      return 0;
    }

    const mailbox = getMailbox(entry, credentials);
    const emails = await mailbox.fetchNew({ sinceUid: entry.cursorUid, signal });
    const ordered = [...(emails ?? [])].sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));

    let ingested = 0;
    for (const email of ordered) {
      metrics.emails_fetched_total += 1;
      const dedupKey = firstNonEmpty(email.message_id, email.id, uidKey(email.uid));

      if (dedupKey && entry.seen.has(dedupKey)) {
        metrics.duplicate_total += 1;
        advanceCursor(entry, email);
        continue;
      }

      let ingressBody: unknown;
      try {
        ingressBody = buildEmailIngress({
          email,
          organizationId: entry.organizationId,
          channelId: entry.channelId,
          now,
        });
      } catch (error) {
        if (error instanceof NonIngestibleEmailError) {
          // Непригодное письмо (пусто и т.п.): пропускаем и двигаем курсор, чтобы
          // не блокировать очередь.
          metrics.skipped_total += 1;
          logger?.warn?.("Skipping non-ingestible email", {
            channel_id: channelId,
            error: describe(error),
          });
          if (dedupKey) {
            rememberSeen(entry, dedupKey);
          }
          advanceCursor(entry, email);
          continue;
        }
        throw error;
      }

      try {
        await ingest(ingressBody);
      } catch (error) {
        // Бэкпрешер RF-буфера/непредвиденный сбой приёма: НЕ двигаем курсор и
        // прерываем батч — письмо переотправится на следующем поллинге
        // (RF-first: не теряется).
        metrics.ingest_retry_total += 1;
        logger?.warn?.("Edge ingest failed; will retry this email on next poll", {
          channel_id: channelId,
          error: describe(error),
        });
        break;
      }

      metrics.ingested_total += 1;
      ingested += 1;
      if (dedupKey) {
        rememberSeen(entry, dedupKey);
      }
      advanceCursor(entry, email);
    }

    return ingested;
  }

  function getMailbox(entry: RegistryEntry, credentials: unknown): EdgeMailbox {
    let mailbox = mailboxes.get(entry.channelId);
    if (!mailbox) {
      mailbox = createMailbox({ credentials, channel: entry });
      mailboxes.set(entry.channelId, mailbox);
    }
    return mailbox;
  }

  async function pollAllOnce(options: { signal?: AbortSignal } = {}): Promise<number> {
    let total = 0;
    for (const channelId of [...registry.keys()]) {
      try {
        total += await pollChannelOnce(channelId, options);
      } catch (error) {
        metrics.poll_failures_total += 1;
        logger?.error?.("Edge email poll failed", { channel_id: channelId, error: describe(error) });
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
          logger?.error?.("Edge email poll failed", {
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
      logger?.info?.("Edge email inbound driver started", { channels: registry.size });

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

function advanceCursor(entry: RegistryEntry, email: RawEmail): void {
  if (Number.isInteger(email.uid)) {
    entry.cursorUid = Math.max(entry.cursorUid ?? 0, email.uid as number);
  }
}

function uidKey(uid: number | undefined): string | undefined {
  return Number.isInteger(uid) ? `uid:${uid}` : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
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
