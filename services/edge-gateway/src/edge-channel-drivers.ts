import { createEdgeControlPlane, type EdgeControlPlaneCipher } from "./edge-control-plane.js";
import { createEdgeMaxInboundDriver } from "./edge-max-inbound-driver.js";
import { createEdgeMaxSender } from "./edge-max-sender.js";
import { createEdgeMaxUpdatesClient } from "./edge-max-updates-client.js";

/**
 * Сборка edge-owned канальных драйверов для рантайма Edge Gateway (Этап M5 плана
 * `docs/plan/max-channel-production.md`, закрывает MG-9 / общий пробел wiring
 * edge-owned каналов).
 *
 * Собирает воедино компоненты M4 в единый рантайм-модуль:
 *   - `EdgeMaxSender` (исходящее MAX Bot API) → инжектится в control-plane;
 *   - `EdgeControlPlane` (кэш кред + реестр каналов из creds-sync + egress-роутинг);
 *   - `EdgeMaxInboundDriver` (входящее getUpdates → RF-first `cluster.ingest`).
 *
 * Источник реестра каналов и токенов — control-plane (Edge не имеет доступа к БД,
 * ТЗ §22.3): Edge поллит только каналы, чьи креды к нему синхронизированы с
 * App-стороны (`channel_credentials_sync`). RF-first, деградацию и дренаж
 * обеспечивает `EdgeCluster` (буфер + туннель).
 *
 * Email подключается сюда же по идентичной схеме (драйвер/ingress/креды уже есть,
 * `imapflow`), как только появится его боевой SMTP-транспорт (nodemailer, MP-12);
 * поэтому модуль назван канально-нейтрально.
 */

export interface EdgeCluster {
  ingest(message: unknown): Promise<unknown>;
}

export interface CreateEdgeChannelRuntimeOptions {
  /** RF-first приёмник входящего (EdgeCluster.ingest). */
  cluster: EdgeCluster;
  /** Шифр для in-memory кэша кред control-plane (совместим с RF-payload-cipher). */
  cipher: EdgeControlPlaneCipher;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
  logger?: any;
}

export function createEdgeChannelRuntime({
  cluster,
  cipher,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  logger = console,
}: CreateEdgeChannelRuntimeOptions) {
  if (!cluster || typeof cluster.ingest !== "function") {
    throw new TypeError("cluster with ingest() is required");
  }

  const maxApiBaseUrl = env.MAX_API_BASE_URL?.trim() || "https://botapi.max.ru";

  // Исходящее MAX (M4): sender инжектится в control-plane для egress_dispatch.
  const maxSender = createEdgeMaxSender({ baseUrl: maxApiBaseUrl, fetchImpl, now });

  // Control-plane: кэш кред + реестр каналов из creds-sync + роутинг egress.
  const controlPlane = createEdgeControlPlane({ cipher, maxSender, now });

  // Входящее MAX (M4): реестр/токен — из control-plane; приём — RF-first в кластер.
  const maxDriver = createEdgeMaxInboundDriver({
    listChannels: async (input) => controlPlane.listChannels(input),
    resolveCredentials: ({ organizationId }) => {
      const token = extractMaxToken(controlPlane.getChannelCredentials(organizationId, "max"));
      return token ? { token } : null;
    },
    createUpdatesClient: ({ credentials }) =>
      createEdgeMaxUpdatesClient({
        token: (credentials as { token: string }).token,
        baseUrl: maxApiBaseUrl,
        fetchImpl,
      }),
    ingest: (body) => cluster.ingest(body),
    now,
    logger,
  });

  return {
    controlPlane,
    maxDriver,
    maxSender,

    async start(): Promise<void> {
      await maxDriver.start({
        refreshIntervalMs: numberEnv(env.MAX_INBOUND_REFRESH_INTERVAL_MS, 30_000),
      });
      logger?.info?.("Edge channel runtime started (MAX)", {});
    },

    stop(): void {
      maxDriver.stop();
    },

    getMetrics() {
      return {
        max_driver: maxDriver.getMetrics(),
        control_plane: controlPlane.getMetrics(),
        max_sender: maxSender.getMetrics(),
      };
    },
  };
}

/** Извлекает токен бота MAX из синхронизированных кред (объект `{token|...}`). */
function extractMaxToken(credentials: unknown): string | undefined {
  const creds = credentials as { token?: unknown; access_token?: unknown; bot_token?: unknown } | null;
  for (const value of [creds?.token, creds?.access_token, creds?.bot_token]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
