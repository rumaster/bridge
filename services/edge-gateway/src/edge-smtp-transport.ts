import type { EdgeSmtpConfig, EdgeSmtpMessage, EdgeSmtpTransport } from "./edge-email-sender.js";

/**
 * Боевая nodemailer-фабрика SMTP-транспорта Edge (Этап M1 плана
 * `docs/plan/mail-service-selfhosted.md`; закрывает практическую часть MP-12 для
 * исходящего email). Реализует сеам `createTransport` из
 * [`edge-email-sender.ts`](./edge-email-sender.ts) — ту точку, где до сих пор
 * подставлялся инъектируемый транспорт из тестов.
 *
 * `nodemailer` грузится **лениво** (dynamic import, как `loadPg` в
 * [`edge-runtime.ts`](./edge-runtime.ts)): пакет не тянется, пока реально не
 * отправляется письмо, и `tsc` не требует `@types/nodemailer`. Транспорт
 * создаётся один раз на конфиг (кэш в самом сендере — по SMTP-хосту/логину).
 */

export interface NodemailerLike {
  createTransport(options: unknown): {
    sendMail(message: unknown): Promise<{ messageId?: string }>;
    /**
     * nodemailer: устанавливает соединение и проверяет AUTH, не отправляя письма.
     * Используется и проверкой подключения канала (Этап E1, `channel_test`), и
     * прогревом транспорта (§4.6) — обе операции вызывают `transporter.verify()`.
     */
    verify(): Promise<unknown>;
  };
}

export interface NodemailerTransportOptions {
  /**
   * false — принимать самоподписанный серверный TLS-сертификат. M1: почтовик
   * поднимается self-signed внутри docker-сети RF-кластера (имя `mailserver` не
   * совпадает с CN сертификата), поэтому на стенде ставится 0. Дефолт — строгая
   * проверка.
   */
  rejectUnauthorized?: boolean;
  /** Инъекция nodemailer-модуля (для тестов); по умолчанию — ленивый dynamic import. */
  load?: () => Promise<NodemailerLike>;
}

let nodemailerModulePromise: Promise<NodemailerLike> | null = null;

function loadNodemailer(): Promise<NodemailerLike> {
  if (!nodemailerModulePromise) {
    // Через new Function, чтобы tsx/node выполнил настоящий dynamic import, а tsc
    // не потребовал типов пакета (тот же приём, что loadPg в edge-runtime).
    const dynamicImport = new Function("specifier", "return import(specifier)");
    nodemailerModulePromise = (dynamicImport("nodemailer") as Promise<any>).then(
      (mod) => (mod?.default ?? mod) as NodemailerLike,
    );
  }
  return nodemailerModulePromise;
}

export function createNodemailerTransport(
  { smtp }: { smtp: EdgeSmtpConfig },
  { rejectUnauthorized = true, load = loadNodemailer }: NodemailerTransportOptions = {},
): EdgeSmtpTransport {
  const port = smtp.port ?? 587;
  // Порт 465 — implicit TLS (secure:true); 587/иные — STARTTLS (secure:false,
  // nodemailer сам поднимает STARTTLS). Явный smtp.tls=true форсирует implicit TLS.
  const secure = port === 465 ? true : smtp.tls === true;

  let transporter:
    | { sendMail(message: unknown): Promise<{ messageId?: string }>; verify(): Promise<unknown> }
    | null = null;

  async function ensureTransporter() {
    if (transporter) {
      return transporter;
    }
    const nodemailer = await load();
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port,
      secure,
      auth: { user: smtp.username, pass: smtp.password },
      tls: { rejectUnauthorized },
    });
    return transporter;
  }

  return {
    // Прогрев (§4.6): поднимает соединение+AUTH заранее, чтобы первый egress не
    // платил cold-start. Ошибку пробрасывает — best-effort-обёртка живёт в
    // `edge-email-sender.warmUp` (там ошибка гасится).
    async verify() {
      const transport = await ensureTransporter();
      if (typeof transport.verify === "function") {
        await transport.verify();
      }
    },
    async sendMail(message: EdgeSmtpMessage) {
      const transport = await ensureTransporter();
      const result = await transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.references && message.references.length > 0
          ? { references: message.references }
          : {}),
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      });
      return { messageId: result?.messageId };
    },
  };
}
