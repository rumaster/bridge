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

/** Отправитель исходящей почты (реальный SMTP — Этап E4; здесь инъектируется). */
export interface EdgeEmailSender {
  send(delivery: EdgeEmailDelivery): Promise<{ external_message_id?: string } | void>;
}

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
  now = () => new Date().toISOString(),
  maxProcessedIds = 10_000,
}: CreateEdgeControlPlaneOptions) {
  if (!cipher || typeof cipher.encrypt !== "function" || typeof cipher.decrypt !== "function") {
    throw new EdgeControlPlaneError("cipher {encrypt, decrypt} is required (in-memory creds cache)");
  }

  // org → зашифрованные креды (в памяти, не в открытом виде).
  const credentialsByOrg = new Map<string, Buffer>();
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
    credentialsByOrg.set(
      organizationId,
      cipher.encrypt(message.payload.credentials, { aad: aadFor(organizationId) }),
    );
    metrics.credentials_synced_total += 1;

    return createEdgeControlAck({
      controlId: message.control_id,
      accepted: true,
      status: "stored",
      receivedAt: now(),
    }) as ControlAck;
  }

  async function dispatchEgress(message: any): Promise<ControlAck> {
    if (!emailSender) {
      metrics.egress_failed_total += 1;
      return createEdgeControlAck({
        controlId: message.control_id,
        accepted: true,
        status: "failed",
        detail: "No email sender configured on Edge",
        receivedAt: now(),
      }) as ControlAck;
    }

    const organizationId = message.organization_id;
    const delivery: EdgeEmailDelivery = {
      ...message.payload,
      organization_id: organizationId,
      credentials: getEmailCredentials(organizationId),
    };

    try {
      const result = (await emailSender.send(delivery)) ?? {};
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

  function getEmailCredentials(organizationId: string): unknown | null {
    const encrypted = credentialsByOrg.get(organizationId);
    if (!encrypted) {
      return null;
    }

    return cipher.decrypt(encrypted, { aad: aadFor(organizationId) });
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

    hasCredentials(organizationId: string): boolean {
      return credentialsByOrg.has(organizationId);
    },

    getMetrics() {
      return { ...metrics, cached_organizations: credentialsByOrg.size };
    },
  };
}
