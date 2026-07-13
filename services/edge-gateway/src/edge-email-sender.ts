import { stableEmailMessageId } from "./edge-ids.js";
import type { EdgeEmailDelivery } from "./edge-control-plane.js";

/**
 * Исходящая доставка email по SMTP на Edge Gateway (Этап E4 плана
 * `docs/plan/email-channel-production.md`, закрывает G-6/G-9 по исходящему
 * направлению).
 *
 * Реализует `EdgeEmailSender` (сеам из control-plane E2): по `egress_dispatch`
 * собирает MIME-письмо и отправляет через SMTP-транспорт организации. Транспорт
 * инъектируется (`createTransport`) — nodemailer-совместимый `sendMail`; реальный
 * сетевой SMTP-клиент подключается боевым daemon (веха MP-12), ровно как реальный
 * IMAP-клиент (E3) и реальный сокет туннеля. По решению 1 SMTP — Edge-owned;
 * app-side HTTP-шлюз `EMAIL_DELIVERY_URL` для email выводится из эксплуатации.
 *
 * Корректность (G-7): `To` = реальный адрес клиента (`recipient_ref`, из
 * `endpoint.external_id`, а НЕ UUID диалога), `From` = адрес организации из кред,
 * `Subject`/`In-Reply-To`/`References` пробрасываются. Идемпотентность: `Message-ID`
 * детерминирован по `message_id`, поэтому повтор отправки не создаёт новое письмо;
 * сверх того control-plane дедуплицирует `egress_dispatch` по `control_id`.
 */

export interface EdgeSmtpConfig {
  host: string;
  port: number;
  tls?: boolean;
  username: string;
  password: string;
}

export interface EdgeSmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename?: string; path: string; contentType?: string }>;
}

export interface EdgeSmtpTransport {
  sendMail(message: EdgeSmtpMessage): Promise<{ messageId?: string } | void>;
  /**
   * Проверка доступности SMTP (EHLO + AUTH) без отправки письма — nodemailer
   * `transporter.verify()`. Две роли: (1) проверка подключения канала (Этап E1,
   * `channel_test`); (2) прогрев транспорта (§4.6) — поднимает TCP+STARTTLS+AUTH
   * заранее, чтобы первая реальная отправка не платила cold-start (иначе холодный
   * транспорт превышает таймаут обёртки egress и письмо помечается ложным
   * `failed`, хотя доставляется). Опционально — инъектируемые в тестах транспорты
   * могут его не реализовывать.
   */
  verify?(): Promise<void>;
}

export interface CreateEdgeEmailSenderOptions {
  /** Фабрика SMTP-транспорта по конфигу организации (nodemailer в боевом daemon). */
  createTransport: (input: { smtp: EdgeSmtpConfig }) => EdgeSmtpTransport;
  now?: () => string;
}

export class EdgeEmailSenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeEmailSenderError";
  }
}

interface StructuredEmailCredentials {
  smtp?: EdgeSmtpConfig;
  from_email?: string;
  from_name?: string;
}

export function createEdgeEmailSender({
  createTransport,
  now = () => new Date().toISOString(),
}: CreateEdgeEmailSenderOptions): {
  send(delivery: EdgeEmailDelivery): Promise<{ external_message_id: string }>;
  warmUp(credentials: unknown): Promise<boolean>;
  getMetrics(): Record<string, number>;
} {
  if (typeof createTransport !== "function") {
    throw new TypeError("createTransport is required");
  }

  // Транспорты кэшируются per-SMTP-конфиг (по организации), как resolving-клиент
  // Telegram кэширует по токену.
  const transportsByKey = new Map<string, EdgeSmtpTransport>();
  const metrics = { sent_total: 0, failed_total: 0, warmed_total: 0, warm_failed_total: 0 };

  function getTransport(smtp: EdgeSmtpConfig): EdgeSmtpTransport {
    const key = `${smtp.host}:${smtp.port}:${smtp.username}`;
    let transport = transportsByKey.get(key);
    if (!transport) {
      transport = createTransport({ smtp });
      transportsByKey.set(key, transport);
    }
    return transport;
  }

  return {
    async send(delivery: EdgeEmailDelivery) {
      const credentials = delivery.credentials as StructuredEmailCredentials | null | undefined;
      if (!credentials?.smtp?.host) {
        metrics.failed_total += 1;
        throw new EdgeEmailSenderError("No SMTP credentials available for organization");
      }

      const to = firstNonEmpty(delivery.recipient_ref);
      if (!to) {
        metrics.failed_total += 1;
        throw new EdgeEmailSenderError("Egress delivery has no recipient address (recipient_ref)");
      }

      const from =
        firstNonEmpty(delivery.from) ??
        formatAddress(credentials.from_email, credentials.from_name);
      if (!from) {
        metrics.failed_total += 1;
        throw new EdgeEmailSenderError("No From address (delivery.from or credentials.from_email)");
      }

      // Детерминированный Message-ID по message_id → идемпотентность отправки.
      const messageId = `<${stableEmailMessageId(
        String(delivery.channel_id ?? "email"),
        delivery.message_id,
      )}@${domainOf(from)}>`;

      const message: EdgeSmtpMessage = {
        from,
        to,
        subject: delivery.subject ?? "",
        text: delivery.text ?? "",
        messageId,
        ...(delivery.in_reply_to ? { inReplyTo: delivery.in_reply_to } : {}),
        ...(delivery.references && delivery.references.length > 0
          ? { references: delivery.references }
          : {}),
        ...(Array.isArray(delivery.attachments) && delivery.attachments.length > 0
          ? { attachments: mapAttachments(delivery.attachments) }
          : {}),
      };

      const result = (await getTransport(credentials.smtp).sendMail(message)) ?? {};
      metrics.sent_total += 1;

      return {
        external_message_id:
          firstNonEmpty((result as { messageId?: string }).messageId) ?? messageId,
      };
    },

    /**
     * Прогрев SMTP-транспорта организации по синхронизированным кредам (§4.6):
     * поднимает соединение заранее (`transporter.verify()`), устраняя cold-start
     * ложный `failed` на первом ответе менеджера после старта Edge. Best-effort —
     * ошибка прогрева (недоступный SMTP, кривые креды) НЕ роняет синхронизацию:
     * возвращается `false`, отправка попробуется как обычно при первом egress.
     */
    async warmUp(credentials: unknown): Promise<boolean> {
      const creds = credentials as StructuredEmailCredentials | null | undefined;
      const smtp = creds?.smtp;
      if (!smtp?.host) {
        return false;
      }
      try {
        const transport = getTransport(smtp);
        if (typeof transport.verify === "function") {
          await transport.verify();
        }
        metrics.warmed_total += 1;
        return true;
      } catch {
        metrics.warm_failed_total += 1;
        return false;
      }
    },

    getMetrics() {
      return { ...metrics, cached_transports: transportsByKey.size };
    },
  };
}

function mapAttachments(attachments: unknown[]): EdgeSmtpMessage["attachments"] {
  return attachments.map((attachment) => {
    const a = attachment as { storage_ref?: string; filename?: string; mime?: string };
    return {
      ...(a.filename ? { filename: a.filename } : {}),
      // Контент вложения тянется из storage по storage_ref боевым daemon
      // (object storage отложен на MVP, см. §4.5); здесь передаётся ссылка.
      path: a.storage_ref ?? "",
      ...(a.mime ? { contentType: a.mime } : {}),
    };
  });
}

function formatAddress(email?: string, name?: string): string | undefined {
  const address = firstNonEmpty(email);
  if (!address) {
    return undefined;
  }
  const displayName = firstNonEmpty(name);
  return displayName ? `"${displayName}" <${address}>` : address;
}

function domainOf(address: string): string {
  const match = /@([^>\s]+)>?\s*$/.exec(address);
  return match?.[1] ?? "edge.local";
}

function firstNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
