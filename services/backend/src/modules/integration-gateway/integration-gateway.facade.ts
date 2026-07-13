import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";

import { FacadeResilience, type FacadeResilienceOptions } from "../../common/resilience/resilience";
import type { PgDatabase } from "../../common/database/database.service";
import type { ChannelSecretEnvelope } from "../../common/secrets/channel-secret.store";
import {
  type EmailChannelCredentials,
  parseEmailChannelCredentials,
  serializeEmailChannelCredentials,
} from "../../common/secrets/email-channel-credentials";
import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";
import type { IntegrationGatewayUpstreamClient } from "./integration-gateway.upstream";

export const INTEGRATION_GATEWAY_CLOCK = Symbol("INTEGRATION_GATEWAY_CLOCK");

export type ChannelStatus = "connected" | "error" | "disabled";
export type ChannelType =
  | "web_chat"
  | "telegram"
  | "email"
  | "sms"
  | "vk"
  | "max"
  | "whatsapp";
export type CapabilityName =
  | "text"
  | "image"
  | "file"
  | "voice"
  | "video"
  | "buttons"
  | "reactions"
  | "typing_indicator"
  | "read_receipt"
  | "delete"
  | "edit";

export interface ChannelFacade {
  id: string;
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  status: ChannelStatus;
  credentials_ref?: string;
  config: Record<string, unknown>;
  last_check_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectWebChatChannelRequest {
  organization_id: string;
  channel_type?: "web_chat";
  name: string;
  credentials_ref?: string;
  credentials?: string;
  config?: Record<string, unknown>;
}

export interface ConnectChannelRequest {
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  credentials_ref?: string;
  /** Plaintext-секрет канала (например токен Telegram-бота). Шифруется, не возвращается. */
  credentials?: string;
  /** Структурные креды email-канала (IMAP + SMTP). Только для channel_type=email. */
  email_credentials?: EmailChannelCredentials;
  config?: Record<string, unknown>;
}

export interface UpdateChannelRequest {
  channel_id: string;
  organization_id: string;
  name?: string;
  /** Новый plaintext-секрет токен-канала. Перешифровывается, не возвращается. */
  credentials?: string;
  /** Новые структурные креды email-канала (IMAP + SMTP). */
  email_credentials?: EmailChannelCredentials;
  config?: Record<string, unknown>;
}

export interface ChannelTestResultFacade {
  accepted: true;
  channel_id: string;
  status: ChannelStatus;
  checked_at: string;
  error?: string;
}

/** Маршрутный минимум активного канала для входящего драйвера SVC-INT (T3, без токена). */
export interface ActiveChannelSummary {
  channel_id: string;
  organization_id: string;
  config: Record<string, unknown>;
}

/** Порт хранилища секретов каналов (реализуется ChannelSecretService, DR-03). */
export interface ChannelSecretPort {
  buildCredentialsRef(input: {
    channelType: string;
    organizationId: string;
    label?: string;
  }): string;
  encrypt(plaintext: string): ChannelSecretEnvelope;
  resolveChannelSecret(input: {
    credentialsRef: string;
    organizationId?: string;
  }): Promise<string | null>;
}

export type ChannelDatabasePort = Pick<PgDatabase, "withTenant">;

export type AdapterName =
  | "web-chat-adapter"
  | "telegram-adapter"
  | "email-adapter"
  | "sms-adapter"
  | "vk-adapter"
  | "max-adapter"
  | "whatsapp-adapter";

export interface CapabilityDescriptorFacade {
  contract: "C6.CapabilityDescriptor";
  version: "1.0.0";
  channel_type: ChannelType;
  channel_id: string;
  adapter: {
    name: AdapterName;
    version: "0.0.0";
  };
  capabilities: Record<CapabilityName, { supported: boolean; notes?: string }>;
  generated_at: string;
}

export interface IntegrationGatewayFacadeOptions {
  clock?: () => string;
  resilience?: FacadeResilience | FacadeResilienceOptions;
  upstream?: IntegrationGatewayUpstreamClient | null;
  database?: ChannelDatabasePort | null;
  channelSecrets?: ChannelSecretPort | null;
  fetchImpl?: typeof globalThis.fetch;
  telegramApiBaseUrl?: string;
  maxApiBaseUrl?: string;
}

interface ChannelRow {
  id: string;
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  status: ChannelStatus;
  credentials_ref: string | null;
  config: Record<string, unknown> | null;
  last_check_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const C6_CAPABILITIES: CapabilityName[] = [
  "text",
  "image",
  "file",
  "voice",
  "video",
  "buttons",
  "reactions",
  "typing_indicator",
  "read_receipt",
  "delete",
  "edit",
];
const WEB_CHAT_SUPPORTED_CAPABILITIES = new Set<CapabilityName>([
  "text",
  "image",
  "file",
  "typing_indicator",
  "read_receipt",
]);
const CHANNEL_CAPABILITY_PROFILES: Record<
  ChannelType,
  {
    adapterName: AdapterName;
    supported: ReadonlySet<CapabilityName>;
    notes?: Partial<Record<CapabilityName, string>>;
  }
> = {
  web_chat: {
    adapterName: "web-chat-adapter",
    supported: WEB_CHAT_SUPPORTED_CAPABILITIES,
  },
  telegram: {
    adapterName: "telegram-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
      "delete",
      "edit",
    ]),
    notes: {
      read_receipt:
        "Telegram Bot API does not expose reliable per-user read receipts to the adapter.",
    },
  },
  email: {
    adapterName: "email-adapter",
    supported: new Set(["text", "image", "file"]),
    notes: {
      read_receipt:
        "Email read receipts are optional and not reliable enough for C6 read_receipt.",
    },
  },
  sms: {
    adapterName: "sms-adapter",
    supported: new Set(["text"]),
  },
  vk: {
    adapterName: "vk-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
    ]),
    notes: {
      read_receipt: "The M2 VK adapter does not publish reliable read receipts to C6.",
    },
  },
  max: {
    adapterName: "max-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
    ]),
    notes: {
      read_receipt: "The M2 MAX adapter does not publish read receipt events.",
    },
  },
  whatsapp: {
    adapterName: "whatsapp-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "read_receipt",
    ]),
    notes: {
      typing_indicator: "The M2 WhatsApp adapter does not expose typing indicators.",
    },
  },
};

@Injectable()
export class IntegrationGatewayFacade implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly clock: () => string;
  private readonly resilience: FacadeResilience;
  private readonly upstream: IntegrationGatewayUpstreamClient | null;
  private readonly database: ChannelDatabasePort | null;
  private readonly channelSecrets: ChannelSecretPort | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly telegramApiBaseUrl: string;
  private readonly maxApiBaseUrl: string;
  private readonly logger = new Logger(IntegrationGatewayFacade.name);
  private credentialsResyncTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Optional()
    @Inject(INTEGRATION_GATEWAY_CLOCK)
    options: IntegrationGatewayFacadeOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.upstream = options.upstream ?? null;
    this.database = options.database ?? null;
    this.channelSecrets = options.channelSecrets ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.telegramApiBaseUrl = (
      options.telegramApiBaseUrl ??
      process.env.TELEGRAM_API_BASE_URL ??
      "https://api.telegram.org"
    ).replace(/\/+$/, "");
    // Хост MAX Bot API (Этап M1, docs/plan/max-channel-production.md). Пустой env
    // → дефолт botapi.max.ru (наследие TamTam Bot API); переопределяется для
    // self-hosted прокси/эмулятора и при уточнении спецификации MAX Bot API.
    this.maxApiBaseUrl = (
      (options.maxApiBaseUrl ?? process.env.MAX_API_BASE_URL ?? "").trim() ||
      "https://botapi.max.ru"
    ).replace(/\/+$/, "");
    this.resilience =
      options.resilience instanceof FacadeResilience
        ? options.resilience
        : new FacadeResilience({
            defaultTimeoutMs: 2_500,
            ...(options.resilience ?? {}),
          });
  }

  getStatus(): FacadeStatusDto {
    return {
      mode: this.upstream ? "http" : "mock",
      name: "integration",
      serviceId: "SVC-INT",
      status: this.upstream ? "available" : "degraded",
    };
  }

  /**
   * Периодический bulk-resync email-кред на Edge (Ш2 плана
   * `docs/plan/email-inbound-edge-implementation.md`). Кэш кред на Edge —
   * in-memory: при рестарте edge-gateway он обнуляется (`channels: 0`), а
   * push-on-write (Ш1) срабатывает только при connect/update. Периодический
   * resync повторно проталкивает креды всех `connected` email-каналов, поэтому
   * Edge восстанавливает реестр в течение одного интервала после рестарта.
   * Идемпотентно: Edge дедупит по `control_id` (стабилен по updated_at), пока его
   * кэш жив, и заново сохраняет после рестарта (кэш обработанных id тоже обнулён).
   *
   * Стартует только в рантайме Nest (не в unit-тестах, где фасад создаётся через
   * `new`) и только при заданном `EDGE_CONTROL_URL`.
   */
  onApplicationBootstrap(): void {
    const rawInterval = process.env.EDGE_CREDENTIALS_RESYNC_INTERVAL_MS;
    const parsedInterval = rawInterval && rawInterval.trim() !== "" ? Number(rawInterval) : NaN;
    const intervalMs = Number.isFinite(parsedInterval) ? parsedInterval : 60_000;
    const edgeControlUrl = process.env.EDGE_CONTROL_URL?.trim();
    if (!edgeControlUrl || intervalMs <= 0 || !this.database || !this.channelSecrets) {
      return;
    }

    const runResync = () => {
      void this.resyncEmailChannelCredentials().catch((error) => {
        this.logger.warn(`Периодический resync email-кред упал: ${String(error)}`);
      });
    };
    runResync();
    this.credentialsResyncTimer = setInterval(runResync, intervalMs);
    this.credentialsResyncTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.credentialsResyncTimer) {
      clearInterval(this.credentialsResyncTimer);
      this.credentialsResyncTimer = undefined;
    }
  }

  async listChannels(organizationId: string): Promise<ChannelFacade[]> {
    const rows = await this.requireDatabase().withTenant(organizationId, (client) =>
      client.query<ChannelRow>(
        `
          SELECT id, organization_id, channel_type, name, status,
                 credentials_ref, config, last_check_at, created_at, updated_at
          FROM channels
          WHERE organization_id = $1
          ORDER BY created_at ASC, id ASC
        `,
        [organizationId],
      ),
    );

    return rows.rows.map((row) => mapRowToFacade(row));
  }

  /**
   * Резолвит plaintext-токен доставки для подключённого канала организации
   * (S2S, Этап T2). Выбирает не отключённый канал нужного типа с
   * `credentials_ref` (предпочитая `connected`) и расшифровывает его секрет.
   * Возвращает null, если канал или секрет не настроены.
   */
  async resolveChannelDeliveryToken(
    organizationId: string,
    channelType: ChannelType,
  ): Promise<string | null> {
    const result = await this.requireDatabase().withTenant(organizationId, (client) =>
      client.query<{ credentials_ref: string | null }>(
        `
          SELECT credentials_ref
          FROM channels
          WHERE organization_id = $1
            AND channel_type = $2
            AND status <> 'disabled'
            AND credentials_ref IS NOT NULL
          ORDER BY (status = 'connected') DESC, updated_at DESC
          LIMIT 1
        `,
        [organizationId, channelType],
      ),
    );

    const credentialsRef = result.rows[0]?.credentials_ref;
    if (!credentialsRef) {
      return null;
    }

    return this.requireChannelSecrets().resolveChannelSecret({ credentialsRef, organizationId });
  }

  /**
   * Список подключённых каналов заданного типа по всем организациям (S2S,
   * Этап T3). Возвращает только маршрутный минимум `{channel_id,
   * organization_id, config}` — БЕЗ токена: входящий драйвер SVC-INT берёт
   * токен отдельным S2S-эндпоинтом секрета (T2). Используется, чтобы SVC-INT,
   * не имея доступа к БД (ТЗ §22.3), знал, для каких ботов поднимать поллер
   * входящих и в какую организацию маппить апдейты. Запрос выполняется как
   * platform operator (кросс-тенантный реестр), сужен по `channel_type` и
   * статусу `connected`.
   */
  async listActiveChannelsByType(channelType: ChannelType): Promise<ActiveChannelSummary[]> {
    const result = await this.requireDatabase().withTenant(
      "",
      (client) =>
        client.query<{
          id: string;
          organization_id: string;
          config: Record<string, unknown> | null;
        }>(
          `
            SELECT id, organization_id, config
            FROM channels
            WHERE channel_type = $1
              AND status = 'connected'
              AND credentials_ref IS NOT NULL
            ORDER BY organization_id ASC, id ASC
          `,
          [channelType],
        ),
      { isPlatformOperator: true },
    );

    return result.rows.map((row) => ({
      channel_id: row.id,
      organization_id: row.organization_id,
      config: row.config ?? {},
    }));
  }

  connectWebChatChannel(request: ConnectWebChatChannelRequest): Promise<ChannelFacade> {
    return this.connectChannel({ ...request, channel_type: "web_chat" });
  }

  async connectChannel(request: ConnectChannelRequest): Promise<ChannelFacade> {
    const timestamp = this.clock();
    const channelType = request.channel_type;
    const channelId = randomUUID();
    const plaintext = this.resolveSecretPlaintext({
      channelType,
      credentials: request.credentials,
      emailCredentials: request.email_credentials,
    });

    let credentialsRef = request.credentials_ref?.trim() || null;
    let envelope: ChannelSecretEnvelope | null = null;
    if (plaintext) {
      const secrets = this.requireChannelSecrets();
      credentialsRef = secrets.buildCredentialsRef({
        channelType,
        organizationId: request.organization_id,
        label: channelId,
      });
      envelope = secrets.encrypt(plaintext);
    }

    const config = request.config ?? {};

    const inserted = await this.requireDatabase().withTenant(
      request.organization_id,
      (client) =>
        client.query<ChannelRow>(
          `
            INSERT INTO channels (
              id, organization_id, channel_type, name, status,
              credentials_ref, credentials_envelope, config, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, 'connected', $5, $6::jsonb, $7::jsonb, $8::timestamptz, $8::timestamptz)
            RETURNING id, organization_id, channel_type, name, status,
                      credentials_ref, config, last_check_at, created_at, updated_at
          `,
          [
            channelId,
            request.organization_id,
            channelType,
            request.name,
            credentialsRef,
            envelope ? JSON.stringify(envelope) : null,
            JSON.stringify(config),
            timestamp,
          ],
        ),
    );

    const channel = mapRowToFacade(inserted.rows[0]);
    // Публикуем структурные email-креды на Edge, чтобы входящий IMAP-драйвер начал
    // поллить ящик (иначе Edge видит channels: 0). Best-effort — см. метод.
    if (channelType === "email" && request.email_credentials) {
      await this.publishChannelCredentialsSync({
        channelId,
        organizationId: request.organization_id,
        channelType,
        credentials: request.email_credentials,
        config,
        credsVersion: timestamp,
      });
    }
    return channel;
  }

  /**
   * Заказ ящика «Bridge Mail» (Этап M5, docs/plan/mail-service-selfhosted.md):
   * backend просит провижининг-агента (`MAIL_PROVISION_URL`, рядом с почтовиком)
   * создать ящик, получает структурные IMAP/SMTP-креды и СРАЗУ подключает их как
   * email-канал организации (`connectChannel`) — administrator не вводит креды
   * вручную. Пароль наружу не возвращается (write-only, envelope-шифрование).
   */
  async provisionManagedMailbox(request: {
    organization_id: string;
    local_part: string;
    name?: string;
  }): Promise<{ address: string; channel: ChannelFacade }> {
    const agentUrl = process.env.MAIL_PROVISION_URL?.trim();
    if (!agentUrl) {
      throw new ServiceUnavailableException({
        code: "MAIL_PROVISION_DISABLED",
        description: "MAIL_PROVISION_URL is not configured",
        humanMessage: "Услуга «Bridge Mail» не настроена.",
      });
    }
    const localPart = request.local_part?.trim();
    if (!localPart || /[@\s]/.test(localPart)) {
      throw new BadRequestException({
        code: "MAIL_LOCAL_PART_INVALID",
        description: "local_part must be a non-empty mailbox name without @ or spaces",
        humanMessage: "Некорректное имя ящика.",
      });
    }

    const token = process.env.MAIL_PROVISION_TOKEN?.trim();
    let response: Response;
    try {
      response = await this.fetchImpl(`${agentUrl.replace(/\/$/, "")}/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ local_part: localPart }),
      });
    } catch (error) {
      throw new ServiceUnavailableException({
        code: "MAIL_PROVISION_UNAVAILABLE",
        description: `mail provisioning agent unreachable: ${String(error)}`,
        humanMessage: "Сервис почты недоступен.",
      });
    }

    const payload = (await response.json().catch(() => ({}))) as {
      address?: string;
      email_credentials?: EmailChannelCredentials;
      error?: string;
    };
    if (!response.ok || !payload.address || !payload.email_credentials) {
      throw new ServiceUnavailableException({
        code: "MAIL_PROVISION_FAILED",
        description: `mail provisioning failed HTTP ${response.status}: ${payload.error ?? ""}`,
        humanMessage: "Не удалось создать почтовый ящик.",
      });
    }

    const channel = await this.connectChannel({
      organization_id: request.organization_id,
      channel_type: "email",
      name: request.name?.trim() || `Bridge Mail: ${payload.address}`,
      email_credentials: payload.email_credentials,
    });

    return { address: payload.address, channel };
  }

  /**
   * Обновляет канал и (опционально) ротирует его секрет (PUT /v1/channels/:id,
   * Этап E0). Изменяемые поля — `name`, `config`; секрет (`credentials` для
   * токен-каналов либо структурные `email_credentials`) перешифровывается заново
   * в `credentials_envelope`. Plaintext-секрет никогда не возвращается. Канал не
   * найден → 404.
   */
  async updateChannel(request: UpdateChannelRequest): Promise<ChannelFacade> {
    const existing = await this.getChannel(request.channel_id, request.organization_id);
    const timestamp = this.clock();
    const name = request.name?.trim() || existing.name;
    const config = request.config ?? existing.config;

    const plaintext = this.resolveSecretPlaintext({
      channelType: existing.channel_type,
      credentials: request.credentials,
      emailCredentials: request.email_credentials,
    });

    if (plaintext) {
      const secrets = this.requireChannelSecrets();
      const credentialsRef =
        existing.credentials_ref ??
        secrets.buildCredentialsRef({
          channelType: existing.channel_type,
          organizationId: existing.organization_id,
          label: existing.id,
        });
      const envelope = secrets.encrypt(plaintext);

      const updated = await this.requireDatabase().withTenant(request.organization_id, (client) =>
        client.query<ChannelRow>(
          `
            UPDATE channels
            SET name = $3, config = $4::jsonb,
                credentials_ref = $5, credentials_envelope = $6::jsonb,
                updated_at = $7::timestamptz
            WHERE id = $1 AND organization_id = $2
            RETURNING id, organization_id, channel_type, name, status,
                      credentials_ref, config, last_check_at, created_at, updated_at
          `,
          [
            request.channel_id,
            request.organization_id,
            name,
            JSON.stringify(config),
            credentialsRef,
            JSON.stringify(envelope),
            timestamp,
          ],
        ),
      );

      const channel = mapRowToFacade(updated.rows[0]);
      // Ротация email-кред → пере-синхронизируем их на Edge (тот же путь, что connect).
      if (existing.channel_type === "email" && request.email_credentials) {
        await this.publishChannelCredentialsSync({
          channelId: existing.id,
          organizationId: existing.organization_id,
          channelType: "email",
          credentials: request.email_credentials,
          config,
          credsVersion: timestamp,
        });
      }
      return channel;
    }

    const updated = await this.requireDatabase().withTenant(request.organization_id, (client) =>
      client.query<ChannelRow>(
        `
          UPDATE channels
          SET name = $3, config = $4::jsonb, updated_at = $5::timestamptz
          WHERE id = $1 AND organization_id = $2
          RETURNING id, organization_id, channel_type, name, status,
                    credentials_ref, config, last_check_at, created_at, updated_at
        `,
        [request.channel_id, request.organization_id, name, JSON.stringify(config), timestamp],
      ),
    );

    return mapRowToFacade(updated.rows[0]);
  }

  async getChannelCapabilities(
    channelId: string,
    organizationId?: string,
  ): Promise<CapabilityDescriptorFacade> {
    const channel = await this.findChannel(channelId, organizationId);
    if (this.upstream) {
      return this.getUpstreamChannelCapabilities(channelId, organizationId, channel ?? undefined);
    }

    if (!channel) {
      throwChannelNotFound();
    }

    return createChannelCapabilityDescriptor({
      channelType: channel.channel_type,
      channelId: channel.id,
      generatedAt: this.clock(),
    });
  }

  async testChannel(
    channelId: string,
    organizationId?: string,
  ): Promise<ChannelTestResultFacade> {
    const channel = await this.getChannel(channelId, organizationId);

    if (channel.channel_type === "telegram") {
      return this.testTelegramChannel(channel);
    }

    if (channel.channel_type === "max") {
      return this.testMaxChannel(channel);
    }

    if (this.upstream) {
      return this.testUpstreamChannel(channel);
    }

    const checkedAt = this.clock();
    await this.persistChannelCheck(channel, {
      status: "connected",
      checkedAt,
      config: channel.config,
    });

    return {
      accepted: true,
      channel_id: channel.id,
      status: "connected",
      checked_at: checkedAt,
    };
  }

  private async testTelegramChannel(channel: ChannelFacade): Promise<ChannelTestResultFacade> {
    const checkedAt = this.clock();
    const config = { ...channel.config };
    let status: ChannelStatus;
    let error: string | undefined;

    const token = channel.credentials_ref
      ? await this.requireChannelSecrets().resolveChannelSecret({
          credentialsRef: channel.credentials_ref,
          organizationId: channel.organization_id,
        })
      : null;

    if (!token) {
      status = "error";
      error = "Токен Telegram-бота не настроен для канала.";
    } else {
      const me = await this.runTelegramGetMe(token);
      if (me.ok) {
        status = "connected";
        if (me.username) {
          config.bot_username = me.username;
        }
        if (me.id !== undefined) {
          config.bot_id = me.id;
        }
      } else {
        status = "error";
        error = me.description ?? "Telegram getMe отклонён.";
      }
    }

    await this.persistChannelCheck(channel, { status, checkedAt, config });

    return {
      accepted: true,
      channel_id: channel.id,
      status,
      checked_at: checkedAt,
      ...(error ? { error } : {}),
    };
  }

  private async runTelegramGetMe(
    token: string,
  ): Promise<{ ok: boolean; username?: string; id?: number | string; description?: string }> {
    const result = await this.resilience.execute(async () => {
      const response = await this.fetchImpl(`${this.telegramApiBaseUrl}/bot${token}/getMe`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const body = (await readJsonSafe(response)) as {
        ok?: boolean;
        description?: string;
        result?: { username?: string; id?: number | string };
      };
      return { httpOk: response.ok, body };
    });

    if (!result.ok) {
      return { ok: false, description: "Не удалось обратиться к Telegram Bot API." };
    }

    const { httpOk, body } = result.value;
    if (!httpOk || body?.ok !== true) {
      return { ok: false, description: body?.description ?? "Telegram getMe отклонён." };
    }

    return { ok: true, username: body.result?.username, id: body.result?.id };
  }

  /**
   * Реальная проверка канала MAX (Этап M1, docs/plan/max-channel-production.md,
   * закрывает MG-2). Резолвит токен бота из `credentials_envelope` и вызывает
   * `GET /me` MAX Bot API: `ok` → `connected` + сохранение `bot_id`/`bot_username`
   * в `config`, иначе `error` с причиной. Симметрично {@link testTelegramChannel}.
   */
  private async testMaxChannel(channel: ChannelFacade): Promise<ChannelTestResultFacade> {
    const checkedAt = this.clock();
    const config = { ...channel.config };
    let status: ChannelStatus;
    let error: string | undefined;

    const token = channel.credentials_ref
      ? await this.requireChannelSecrets().resolveChannelSecret({
          credentialsRef: channel.credentials_ref,
          organizationId: channel.organization_id,
        })
      : null;

    if (!token) {
      status = "error";
      error = "Токен бота MAX не настроен для канала.";
    } else {
      const me = await this.runMaxGetMe(token);
      if (me.ok) {
        status = "connected";
        if (me.username) {
          config.bot_username = me.username;
        }
        if (me.id !== undefined) {
          config.bot_id = me.id;
        }
      } else {
        status = "error";
        error = me.description ?? "MAX /me отклонён.";
      }
    }

    await this.persistChannelCheck(channel, { status, checkedAt, config });

    return {
      accepted: true,
      channel_id: channel.id,
      status,
      checked_at: checkedAt,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Вызов `GET {MAX_API_BASE_URL}/me?access_token=<token>` MAX Bot API (наследие
   * TamTam): успех — тело `{ user_id, name, username }`. Токен передаётся в
   * query-параметре по контракту провайдера; URL не логируется.
   */
  private async runMaxGetMe(
    token: string,
  ): Promise<{ ok: boolean; username?: string; id?: number | string; description?: string }> {
    const result = await this.resilience.execute(async () => {
      const url = `${this.maxApiBaseUrl}/me?access_token=${encodeURIComponent(token)}`;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const body = (await readJsonSafe(response)) as {
        user_id?: number | string;
        name?: string;
        username?: string;
        code?: string;
        message?: string;
        description?: string;
      };
      return { httpOk: response.ok, body };
    });

    if (!result.ok) {
      return { ok: false, description: "Не удалось обратиться к MAX Bot API." };
    }

    const { httpOk, body } = result.value;
    if (!httpOk || body?.user_id === undefined) {
      return { ok: false, description: body?.message ?? body?.description ?? "MAX /me отклонён." };
    }

    return { ok: true, username: body.username ?? body.name, id: body.user_id };
  }

  private async persistChannelCheck(
    channel: ChannelFacade,
    { status, checkedAt, config }: { status: ChannelStatus; checkedAt: string; config: Record<string, unknown> },
  ): Promise<void> {
    await this.requireDatabase().withTenant(channel.organization_id, (client) =>
      client.query(
        `
          UPDATE channels
          SET status = $3, last_check_at = $4::timestamptz, config = $5::jsonb, updated_at = $4::timestamptz
          WHERE id = $1 AND organization_id = $2
        `,
        [channel.id, channel.organization_id, status, checkedAt, JSON.stringify(config)],
      ),
    );
  }

  private async getChannel(channelId: string, organizationId?: string): Promise<ChannelFacade> {
    const channel = await this.findChannel(channelId, organizationId);
    if (!channel) {
      throwChannelNotFound();
    }

    return channel;
  }

  private async findChannel(
    channelId: string,
    organizationId?: string,
  ): Promise<ChannelFacade | null> {
    if (!organizationId) {
      return null;
    }

    const result = await this.requireDatabase().withTenant(organizationId, (client) =>
      client.query<ChannelRow>(
        `
          SELECT id, organization_id, channel_type, name, status,
                 credentials_ref, config, last_check_at, created_at, updated_at
          FROM channels
          WHERE id = $1 AND organization_id = $2
        `,
        [channelId, organizationId],
      ),
    );

    return result.rowCount && result.rowCount > 0 ? mapRowToFacade(result.rows[0]) : null;
  }

  private async getUpstreamChannelCapabilities(
    channelId: string,
    organizationId: string | undefined,
    channel?: ChannelFacade,
  ): Promise<CapabilityDescriptorFacade> {
    const result = await this.resilience.execute(() =>
      this.upstream!.getChannelCapabilities(channelId, organizationId, channel?.channel_type),
    );
    if (result.ok) {
      return normalizeCapabilityDescriptor(result.value, {
        channelId,
        fallbackGeneratedAt: this.clock(),
      });
    }

    if (channel) {
      return createChannelCapabilityDescriptor({
        channelType: channel.channel_type,
        channelId: channel.id,
        generatedAt: this.clock(),
      });
    }

    throwChannelNotFound();
  }

  private async testUpstreamChannel(channel: ChannelFacade): Promise<ChannelTestResultFacade> {
    const result = await this.resilience.execute(async () => {
      if (this.upstream?.testChannel) {
        return this.upstream.testChannel(channel);
      }
      await this.upstream!.getChannelCapabilities(
        channel.id,
        channel.organization_id,
        channel.channel_type,
      );
      return { status: "connected" as const, checked_at: this.clock() };
    });
    const checkedAt =
      result.ok && typeof result.value.checked_at === "string"
        ? result.value.checked_at
        : this.clock();
    const status = result.ok ? result.value.status : ("error" as const);

    await this.persistChannelCheck(channel, { status, checkedAt, config: channel.config });

    return {
      accepted: true,
      channel_id: channel.id,
      checked_at: checkedAt,
      status,
    };
  }

  /**
   * Единый резолв plaintext-секрета для connect/update: структурные
   * `email_credentials` (только для channel_type=email) сериализуются в JSON,
   * иначе берётся токен-строка `credentials`. Возвращает undefined, если секрет
   * не передан (обновление без ротации).
   */
  private resolveSecretPlaintext(input: {
    channelType: ChannelType;
    credentials?: string;
    emailCredentials?: EmailChannelCredentials;
  }): string | undefined {
    if (input.emailCredentials) {
      if (input.channelType !== "email") {
        throw new BadRequestException({
          code: "CHANNEL_CREDENTIALS_MISMATCH",
          description: "email_credentials is only valid for channel_type=email.",
          humanMessage: "Структурные email-креды допустимы только для канала email.",
        });
      }

      return serializeEmailChannelCredentials(input.emailCredentials);
    }

    return input.credentials?.trim() || undefined;
  }

  /**
   * Публикует структурные email-креды канала на Edge Gateway через App→Edge
   * control-plane (`C9.EdgeControlMessage` type=`channel_credentials_sync`), тем же
   * HTTP-путём `EDGE_CONTROL_URL`, что и egress. Edge кладёт креды в in-memory кэш
   * и регистрирует канал в реестре → входящий IMAP-драйвер начинает поллить ящик
   * (иначе Edge видит `channels: 0`), а `egress_dispatch` получает SMTP-креды.
   *
   * Best-effort: недоступность/отказ Edge НЕ ломает connect/update канала (bulk-resync,
   * Ш2 плана, довосстановит; кэш Edge — in-memory и теряется при рестарте). `credentials`
   * идёт **объектом** (валидатор control-plane требует object, не сериализованную строку).
   * Идемпотентность — `control_id = creds-<channel_id>-<credsVersion>` (`credsVersion` =
   * `updated_at` канала): один и тот же push (connect/update/resync) для неизменного
   * состояния канала дедупится Edge, ротация кред даёт новый id. Мультиканальность —
   * ключевание по `channel_id` (`edge-control-plane.storeCredentials`).
   */
  private async publishChannelCredentialsSync(input: {
    channelId: string;
    organizationId: string;
    channelType: ChannelType;
    credentials: EmailChannelCredentials;
    config: Record<string, unknown>;
    /** Стабильный маркер версии кред (`updated_at` канала) — основа `control_id`. */
    credsVersion: string;
  }): Promise<void> {
    const edgeControlUrl = process.env.EDGE_CONTROL_URL?.trim();
    if (!edgeControlUrl) {
      return;
    }

    const controlMessage = {
      contract: "C9.EdgeControlMessage",
      version: "1.0.0",
      control_id: `creds-${input.channelId}-${input.credsVersion}`,
      type: "channel_credentials_sync",
      organization_id: input.organizationId,
      issued_at: this.clock(),
      payload: {
        channel_id: input.channelId,
        channel_type: input.channelType,
        credentials: input.credentials,
        config: input.config,
      },
    };

    const token = process.env.EDGE_CONTROL_TOKEN?.trim();
    try {
      const response = await this.fetchImpl(edgeControlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(controlMessage),
      });
      if (!response.ok) {
        this.logger.warn(
          `Edge отклонил channel_credentials_sync HTTP ${response.status} (канал ${input.channelId})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось синхронизировать креды канала на Edge (${input.channelId}): ${String(error)}`,
      );
    }
  }

  /**
   * Bulk-resync (Ш2): проталкивает креды ВСЕХ `connected` email-каналов на Edge —
   * восстанавливает его in-memory реестр после рестарта edge-gateway. Резолв кред
   * **по `channel_id`** (не `LIMIT 1`, как `resolveChannelDeliveryToken`), поэтому у
   * организации может быть несколько email-ящиков. Best-effort: сбой одного канала
   * не прерывает остальные. No-op без `EDGE_CONTROL_URL` / БД / секрет-стора.
   */
  async resyncEmailChannelCredentials(): Promise<{ synced: number; total: number }> {
    if (!process.env.EDGE_CONTROL_URL?.trim() || !this.database || !this.channelSecrets) {
      return { synced: 0, total: 0 };
    }

    const channels = await this.listConnectedEmailChannelsForSync();
    let synced = 0;
    for (const channel of channels) {
      try {
        const secret = await this.requireChannelSecrets().resolveChannelSecret({
          credentialsRef: channel.credentials_ref,
          organizationId: channel.organization_id,
        });
        if (!secret) {
          continue;
        }
        const credentials = parseEmailChannelCredentials(secret);
        await this.publishChannelCredentialsSync({
          channelId: channel.id,
          organizationId: channel.organization_id,
          channelType: "email",
          credentials,
          config: channel.config,
          credsVersion: channel.updated_at,
        });
        synced += 1;
      } catch (error) {
        this.logger.warn(`resync email-кред канала ${channel.id} пропущен: ${String(error)}`);
      }
    }

    if (channels.length > 0) {
      this.logger.log(`Email creds resync: ${synced}/${channels.length} каналов отправлено на Edge`);
    }
    return { synced, total: channels.length };
  }

  /**
   * Кросс-тенантный список `connected` email-каналов с `credentials_ref` и
   * `updated_at` для bulk-resync (platform operator, per-channel — не `LIMIT 1`).
   */
  private async listConnectedEmailChannelsForSync(): Promise<
    Array<{
      id: string;
      organization_id: string;
      credentials_ref: string;
      config: Record<string, unknown>;
      updated_at: string;
    }>
  > {
    const result = await this.requireDatabase().withTenant(
      "",
      (client) =>
        client.query<{
          id: string;
          organization_id: string;
          credentials_ref: string;
          config: Record<string, unknown> | null;
          updated_at: Date | string;
        }>(
          `
            SELECT id, organization_id, credentials_ref, config, updated_at
            FROM channels
            WHERE channel_type = 'email'
              AND status = 'connected'
              AND credentials_ref IS NOT NULL
            ORDER BY organization_id ASC, id ASC
          `,
        ),
      { isPlatformOperator: true },
    );

    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      credentials_ref: row.credentials_ref,
      config: row.config ?? {},
      updated_at: toIso(row.updated_at),
    }));
  }

  private requireDatabase(): ChannelDatabasePort {
    if (!this.database) {
      throw new Error("IntegrationGatewayFacade requires a database for channel persistence");
    }

    return this.database;
  }

  private requireChannelSecrets(): ChannelSecretPort {
    if (!this.channelSecrets) {
      throw new Error("IntegrationGatewayFacade requires a channel secret store for token handling");
    }

    return this.channelSecrets;
  }
}

function mapRowToFacade(row: ChannelRow): ChannelFacade {
  return {
    id: row.id,
    organization_id: row.organization_id,
    channel_type: row.channel_type,
    name: row.name,
    status: row.status,
    ...(row.credentials_ref ? { credentials_ref: row.credentials_ref } : {}),
    config: row.config ?? {},
    ...(row.last_check_at ? { last_check_at: toIso(row.last_check_at) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function readJsonSafe(response: { text(): Promise<string> }): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeCapabilityDescriptor(
  descriptor: Record<string, unknown>,
  {
    channelId,
    fallbackGeneratedAt,
  }: { channelId: string; fallbackGeneratedAt: string },
): CapabilityDescriptorFacade {
  return {
    adapter: descriptor.adapter as CapabilityDescriptorFacade["adapter"],
    capabilities: descriptor.capabilities as CapabilityDescriptorFacade["capabilities"],
    channel_id:
      typeof descriptor.channel_id === "string" ? descriptor.channel_id : channelId,
    channel_type: descriptor.channel_type as ChannelType,
    contract: "C6.CapabilityDescriptor",
    generated_at:
      typeof descriptor.generated_at === "string"
        ? descriptor.generated_at
        : fallbackGeneratedAt,
    version: "1.0.0",
  };
}

function throwChannelNotFound(): never {
  throw new NotFoundException({
    code: "CHANNEL_NOT_FOUND",
    description: "Channel was not found.",
    humanMessage: "Канал не найден.",
  });
}

function createChannelCapabilityDescriptor({
  channelType,
  channelId,
  generatedAt,
}: {
  channelType: ChannelType;
  channelId: string;
  generatedAt: string;
}): CapabilityDescriptorFacade {
  const profile = CHANNEL_CAPABILITY_PROFILES[channelType];

  return {
    contract: "C6.CapabilityDescriptor",
    version: "1.0.0",
    channel_type: channelType,
    channel_id: channelId,
    adapter: {
      name: profile.adapterName,
      version: "0.0.0",
    },
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        profile.supported.has(capability)
          ? { supported: true }
          : {
              supported: false,
              notes:
                profile.notes?.[capability] ??
                `Not supported by the M2 ${channelType} adapter.`,
            },
      ]),
    ) as Record<CapabilityName, { supported: boolean; notes?: string }>,
    generated_at: generatedAt,
  };
}
