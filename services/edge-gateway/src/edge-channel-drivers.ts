import {
  createFilesystemAttachmentStore,
  type EdgeAttachmentStore,
} from "./edge-attachment-store.js";
import { createEdgeEmailTester } from "./edge-channel-tester.js";
import { createEdgeControlPlane, type EdgeControlPlaneCipher } from "./edge-control-plane.js";
import { createEdgeEmailInboundDriver } from "./edge-email-inbound-driver.js";
import { createEdgeEmailSender } from "./edge-email-sender.js";
import { createEdgeMaxInboundDriver } from "./edge-max-inbound-driver.js";
import { createEdgeMaxSender } from "./edge-max-sender.js";
import { createEdgeMaxUpdatesClient } from "./edge-max-updates-client.js";
import { createImapMailbox, defaultImapClientFactory } from "./edge-imap-mailbox.js";
import { createNodemailerTransport } from "./edge-smtp-transport.js";

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
 * Email подключён здесь же по идентичной схеме (Этап M1 плана
 * `docs/plan/mail-service-selfhosted.md`): входящее — `EdgeEmailInboundDriver`
 * (IMAP poll через `createImapMailbox`/`imapflow`) → RF-first `cluster.ingest`;
 * исходящее — `EdgeEmailSender` с боевым nodemailer-транспортом
 * (`createNodemailerTransport`), инжектится в control-plane под `egress_dispatch`
 * с `channel_type != "max"`. Реестр email-каналов и креды — тоже из control-plane
 * (creds-sync App→Edge), как у MAX.
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

  // M1: self-signed TLS почтовика внутри docker-сети принимается при
  // EMAIL_TLS_REJECT_UNAUTHORIZED=0 (дефолт — строгая проверка для боевых кред).
  const emailTlsRejectUnauthorized = (env.EMAIL_TLS_REJECT_UNAUTHORIZED ?? "1").trim() !== "0";

  // Хранилище байтов вложений (§4.3): файловый том на RF (MVP). Пусто →
  // вложения приезжают только метаданными (как раньше), приём не ломается.
  const attachmentStore: EdgeAttachmentStore | undefined = env.EMAIL_ATTACHMENT_STORAGE_DIR?.trim()
    ? createFilesystemAttachmentStore({
        baseDir: env.EMAIL_ATTACHMENT_STORAGE_DIR.trim(),
        maxBytes: numberEnv(env.EMAIL_ATTACHMENT_MAX_BYTES, 25 * 1024 * 1024),
      })
    : undefined;

  // Исходящее email (Этап E4/M1): боевой nodemailer SMTP-транспорт за сеамом
  // createTransport; инжектится в control-plane для egress_dispatch (email).
  const emailSender = createEdgeEmailSender({
    createTransport: ({ smtp }) =>
      createNodemailerTransport({ smtp }, { rejectUnauthorized: emailTlsRejectUnauthorized }),
    // Исходящие вложения (§4.3-bis follow-up п.2): sender резолвит storage_ref в
    // реальные байты из того же тома, что хранит входящие, и вкладывает их в письмо.
    attachmentStore,
    now,
  });

  // Проверка подключения email-канала (Этап E1): channel_test → реальный IMAP
  // LOGIN (connect+logout боевого imapflow) + SMTP verify (EHLO+AUTH nodemailer).
  // Те же боевые клиенты и та же RF-сторона, что приём/отправка.
  const channelTester = createEdgeEmailTester({
    probeImap: async (config) => {
      const client = defaultImapClientFactory(config, {
        rejectUnauthorized: emailTlsRejectUnauthorized,
      });
      await client.connect();
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          // Логин уже проверен успешно — сбой закрытия соединения не важен.
        }
      }
    },
    probeSmtp: async ({ smtp }) => {
      const transport = createNodemailerTransport(
        { smtp },
        { rejectUnauthorized: emailTlsRejectUnauthorized },
      );
      await transport.verify?.();
    },
  });

  // Control-plane: кэш кред + реестр каналов из creds-sync + роутинг egress
  // (channel_type="max" → maxSender, иначе → emailSender) + channel_test.
  const controlPlane = createEdgeControlPlane({
    cipher,
    maxSender,
    emailSender,
    channelTester,
    now,
  });

  // Входящее email (Этап E3/M1): реестр каналов/креды — из control-plane; приём
  // по IMAP (poll по курсору UID) через боевой createImapMailbox; RF-first в кластер.
  const emailDriver = createEdgeEmailInboundDriver({
    listChannels: async ({ channelType }) => controlPlane.listChannels({ channelType }),
    resolveCredentials: ({ organizationId }) => controlPlane.getEmailCredentials(organizationId),
    createMailbox: ({ credentials, channel }) =>
      createImapMailbox(
        { credentials, channel },
        { tlsRejectUnauthorized: emailTlsRejectUnauthorized, attachmentStore, logger },
      ),
    ingest: (body) => cluster.ingest(body),
    pollIntervalMs: numberEnv(env.EMAIL_INBOUND_POLL_INTERVAL_MS, 15_000),
    retryDelayMs: numberEnv(env.EMAIL_INBOUND_RETRY_DELAY_MS, 5_000),
    now,
    logger,
  });

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
    emailDriver,
    emailSender,
    /** Хранилище вложений для резолва на выдаче (server route). */
    attachmentStore,

    async start(): Promise<void> {
      await maxDriver.start({
        refreshIntervalMs: numberEnv(env.MAX_INBOUND_REFRESH_INTERVAL_MS, 30_000),
      });
      await emailDriver.start({
        refreshIntervalMs: numberEnv(env.EMAIL_INBOUND_REFRESH_INTERVAL_MS, 30_000),
      });
      logger?.info?.("Edge channel runtime started (MAX + email)", {});
    },

    stop(): void {
      maxDriver.stop();
      emailDriver.stop();
    },

    getMetrics() {
      return {
        max_driver: maxDriver.getMetrics(),
        email_driver: emailDriver.getMetrics(),
        control_plane: controlPlane.getMetrics(),
        max_sender: maxSender.getMetrics(),
        email_sender: emailSender.getMetrics(),
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
