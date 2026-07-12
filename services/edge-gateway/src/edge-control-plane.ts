import {
  createEdgeControlAck,
  validateEdgeControlMessage,
} from "../../../packages/contracts/src/c9.js";

/**
 * Edge-сторона control-plane туннеля Edge↔App (Этап E2 плана
 * `docs/plan/email-channel-production.md`, закрывает G-10).
 *
 * Data-plane туннеля однонаправлен (Edge→App: входящее сообщение + ack). Для
 * email нужно обратное направление App→Edge:
 *   - `channel_credentials_sync` — App проталкивает структурные креды email-канала
 *     (расшифрованные из `channels.credentials_envelope` на стороне Backend); Edge
 *     кладёт их в локальный кэш, **зашифрованными в памяти** (тот же
 *     RF-payload-cipher, что и RF-буфер), и НЕ персистит в открытом виде;
 *   - `egress_dispatch` — App поручает Edge отправить исходящее письмо; фактическую
 *     SMTP-отправку выполняет инъектируемый `emailSender` (Этап E4), а control-plane
 *     лишь маршрутизирует и возвращает статус.
 *
 * Идемпотентность: повтор `control_id` (например после переподключения туннеля)
 * не выполняется заново — возвращается прежний ack с `duplicate:true`. Отправка
 * при этом не дублируется. Кэш обработанных id ограничен (FIFO-вытеснение).
 */

export class EdgeControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeControlPlaneError";
  }
}

/** Симметричный шифр для кэша кред в памяти (совместим с RF-payload-cipher). */
export interface EdgeControlPlaneCipher {
  encrypt(payload: unknown, options?: { aad?: unknown }): Buffer;
  decrypt(envelope: Buffer, options?: { aad?: unknown }): unknown;
}

/** Отправитель исходящего сообщения канала (SMTP для email E4, MAX Bot API M4). */
export interface EdgeEmailSender {
  send(delivery: EdgeEmailDelivery): Promise<{ external_message_id?: string } | void>;
}

/** Псевдоним для сеама отправки любого edge-owned канала (email/MAX). */
export type EdgeChannelSender = EdgeEmailSender;

export interface EdgeEmailDelivery {
  organization_id: string;
  message_id: string;
  channel_id?: string;
  channel_type: string;
  recipient_ref?: string;
  subject?: string;
  from?: string;
  text?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: unknown[];
  /** Разрешённые креды организации (IMAP/SMTP) из локального кэша Edge. */
  credentials?: unknown;
  [key: string]: unknown;
}

export interface CreateEdgeControlPlaneOptions {
  cipher: EdgeControlPlaneCipher;
  emailSender?: EdgeEmailSender;
  /** Отправитель MAX (Этап M4): egress_dispatch с channel_type="max" идёт сюда. */
  maxSender?: EdgeChannelSender;
  now?: () => string;
  /** Верхняя граница памяти дедупа обработанных control_id (FIFO-вытеснение). */
  maxProcessedIds?: number;
}

interface ControlAck {
  contract: string;
  version: string;
  control_id: string;
  accepted: boolean;
  duplicate: boolean;
  status: string;
  detail?: string;
  external_message_id?: string;
  received_at: string;
}

export function createEdgeControlPlane({
  cipher,
  emailSender,
  maxSender,
  now = () => new Date().toISOString(),
  maxProcessedIds = 10_000,
}: CreateEdgeControlPlaneOptions) {
  if (!cipher || typeof cipher.encrypt !== "function" || typeof cipher.decrypt !== "function") {
    throw new EdgeControlPlaneError("cipher {encrypt, decrypt} is required (in-memory creds cache)");
  }

  // `${org}:${channel_type}` → зашифрованные креды (в памяти, не в открытом виде).
  // Ключ включает channel_type, чтобы креды email и MAX одной организации не
  // затирали друг друга (Этап M4).
  const credentialsByKey = new Map<string, Buffer>();
  // channelId → {organizationId, channelType, config}: реестр каналов, известных
  // Edge (выводится из синхронизированных кред — Этап M5). Источник `listChannels`
  // для edge-owned входящих драйверов: Edge поллит только те каналы, чьи креды к
  // нему пришли с App-стороны (нет прямого доступа к БД, ТЗ §22.3).
  const channelsById = new Map<
    string,
    { channelId: string; organizationId: string; channelType: string; config: Record<string, unknown> }
  >();
  // control_id → выданный ack (идемпотентность повторов), ограничен по размеру.
  const processed = new Map<string, ControlAck>();
  const metrics = {
    credentials_synced_total: 0,
    egress_sent_total: 0,
    egress_failed_total: 0,
    duplicate_total: 0,
    rejected_total: 0,
  };

  function aadFor(organizationId: string) {
    return { organization_id: organizationId, scope: "edge-control-credentials" };
  }

  function credentialKey(organizationId: string, channelType: string) {
    return `${organizationId}:${channelType}`;
  }

  function remember(controlId: string, ack: ControlAck) {
    processed.set(controlId, ack);
    if (processed.size > maxProcessedIds) {
      const oldest = processed.keys().next().value;
      if (oldest !== undefined) {
        processed.delete(oldest);
      }
    }
  }

  function storeCredentials(message: any): ControlAck {
    const organizationId = message.organization_id;
    const channelType = message.payload.channel_type ?? "email";
    credentialsByKey.set(
      credentialKey(organizationId, channelType),
      cipher.encrypt(message.payload.credentials, { aad: aadFor(organizationId) }),
    );
    // Реестр каналов Edge (M5): channel_id из creds-sync делает канал видимым для
    // edge-owned входящего драйвера соответствующего типа.
    const channelId = message.payload.channel_id;
    if (typeof channelId === "string" && channelId.trim() !== "") {
      channelsById.set(channelId, {
        channelId,
        organizationId,
        channelType,
        config: isRecord(message.payload.config) ? message.payload.config : {},
      });
    }
    metrics.credentials_synced_total += 1;

    return createEdgeControlAck({
      controlId: message.control_id,
      accepted: true,
      status: "stored",
      receivedAt: now(),
    }) as ControlAck;
  }

  async function dispatchEgress(message: any): Promise<ControlAck> {
    const channelType = message.payload?.channel_type ?? "email";
    const sender = channelType === "max" ? maxSender : emailSender;
    if (!sender) {
      metrics.egress_failed_total += 1;
      return createEdgeControlAck({
        controlId: message.control_id,
        accepted: true,
        status: "failed",
        detail:
          channelType === "max"
            ? "No MAX sender configured on Edge"
            : "No email sender configured on Edge",
        receivedAt: now(),
      }) as ControlAck;
    }

    const organizationId = message.organization_id;
    const delivery: EdgeEmailDelivery = {
      ...message.payload,
      organization_id: organizationId,
      credentials: getChannelCredentials(organizationId, channelType),
    };

    try {
      const result = (await sender.send(delivery)) ?? {};
      metrics.egress_sent_total += 1;
      return createEdgeControlAck({
        controlId: message.control_id,
        accepted: true,
        status: "sent",
        externalMessageId: (result as { external_message_id?: string }).external_message_id,
        receivedAt: now(),
      }) as ControlAck;
    } catch (error) {
      metrics.egress_failed_total += 1;
      return createEdgeControlAck({
        controlId: message.control_id,
        accepted: true,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        receivedAt: now(),
      }) as ControlAck;
    }
  }

  /** Разрешённые креды организации по каналу из локального кэша (Этапы E3/E4/M4). */
  function getChannelCredentials(organizationId: string, channelType: string): unknown | null {
    const encrypted = credentialsByKey.get(credentialKey(organizationId, channelType));
    if (!encrypted) {
      return null;
    }

    return cipher.decrypt(encrypted, { aad: aadFor(organizationId) });
  }

  /** Обратно-совместимый алиас для email-кред (Этапы E3/E4). */
  function getEmailCredentials(organizationId: string): unknown | null {
    return getChannelCredentials(organizationId, "email");
  }

  function hasCredentials(organizationId: string, channelType?: string): boolean {
    if (channelType) {
      return credentialsByKey.has(credentialKey(organizationId, channelType));
    }
    const prefix = `${organizationId}:`;
    for (const key of credentialsByKey.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  return {
    /** Обрабатывает валидное App→Edge control-сообщение, возвращает C9-ack. */
    async handle(message: any): Promise<ControlAck> {
      const validation = validateEdgeControlMessage(message);
      if (!validation.valid) {
        metrics.rejected_total += 1;
        throw new EdgeControlPlaneError(
          `Invalid C9 control message: ${validation.errors.join("; ")}`,
        );
      }

      const prior = processed.get(message.control_id);
      if (prior) {
        metrics.duplicate_total += 1;
        return { ...prior, duplicate: true };
      }

      let ack: ControlAck;
      if (message.type === "channel_credentials_sync") {
        ack = storeCredentials(message);
      } else if (message.type === "egress_dispatch") {
        ack = await dispatchEgress(message);
      } else {
        metrics.rejected_total += 1;
        throw new EdgeControlPlaneError(`Unsupported control message type: ${message.type}`);
      }

      remember(message.control_id, ack);
      return ack;
    },

    /** Разрешённые креды организации из локального кэша (для Этапов E3/E4). */
    getEmailCredentials,

    /** Разрешённые креды организации по каналу (email/MAX, Этап M4). */
    getChannelCredentials,

    /**
     * Реестр каналов типа `channelType`, известных Edge (выведен из
     * синхронизированных кред, Этап M5). Источник `listChannels` для edge-owned
     * входящих драйверов.
     */
    listChannels({ channelType }: { channelType: string }) {
      return [...channelsById.values()]
        .filter((entry) => entry.channelType === channelType)
        .map((entry) => ({
          channelId: entry.channelId,
          organizationId: entry.organizationId,
          config: entry.config,
        }));
    },

    hasCredentials,

    getMetrics() {
      return { ...metrics, cached_organizations: credentialsByKey.size };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
