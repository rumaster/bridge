import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import type { EdgeMailbox } from "./edge-email-inbound-driver.js";
import type { RawEmail, RawEmailAttachment } from "./edge-email-ingress.js";

/**
 * Реальный IMAP-ящик Edge Gateway (Этап E3 плана
 * `docs/plan/email-inbound-edge-implementation.md`) — боевая реализация сеама
 * `createMailbox`/`EdgeMailbox` входящего драйвера
 * ([`edge-email-inbound-driver.ts`](./edge-email-inbound-driver.ts)).
 *
 * Забирает новые письма по IMAP (poll по курсору UID), парсит MIME
 * ([`mailparser`]) в `RawEmail` — форму, которую нормализует
 * [`buildEmailIngress`](./edge-email-ingress.ts). IMAP-клиент инъектируется
 * (`clientFactory`), поэтому unit-тесты гоняют маппинг без реального сокета, а в
 * рантайме подставляется [`ImapFlow`].
 *
 * Историю ящика НЕ импортируем: при первом контакте фиксируем базовый UID и
 * принимаем только письма, пришедшие после старта поллинга канала (осознанный
 * дефолт для живого support-ящика — иначе весь архив хлынул бы менеджеру).
 */

/** Креды одного IMAP-эндпоинта (подмножество EmailChannelCredentials.imap). */
export interface EdgeImapEndpointCredentials {
  host: string;
  port?: number;
  tls?: boolean;
  username: string;
  password: string;
}

/** Минимальная поверхность IMAP-клиента, используемая ящиком (совместима с ImapFlow). */
export interface EdgeImapClient {
  usable?: boolean;
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  mailbox?: { uidNext?: number } | false;
  fetch(
    range: string,
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AsyncIterable<{ uid: number; source?: Buffer | Uint8Array }>;
  logout(): Promise<void>;
  close(): void;
}

export interface ImapClientConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

export interface CreateImapMailboxInput {
  credentials: unknown;
  channel: { channelId: string; organizationId: string };
}

export interface CreateImapMailboxOptions {
  clientFactory?: (config: ImapClientConfig) => EdgeImapClient;
  mailbox?: string;
  /** Максимум писем за один poll: остаток догоняется на следующем поллинге. */
  fetchLimit?: number;
  logger?: {
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
  };
}

const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_FETCH_LIMIT = 50;

export function createImapMailbox(
  { credentials }: CreateImapMailboxInput,
  {
    clientFactory = defaultImapClientFactory,
    mailbox = DEFAULT_MAILBOX,
    fetchLimit = DEFAULT_FETCH_LIMIT,
  }: CreateImapMailboxOptions = {},
): EdgeMailbox {
  const imap = extractImapEndpoint(credentials);

  let client: EdgeImapClient | null = null;
  // Базовый UID на момент первого подключения (см. заголовок модуля).
  let baselineUid: number | undefined;

  async function ensureClient(): Promise<EdgeImapClient> {
    if (client && client.usable !== false) {
      return client;
    }
    const created = clientFactory({
      host: imap.host,
      port: imap.port ?? 993,
      secure: imap.tls ?? true,
      auth: { user: imap.username, pass: imap.password },
    });
    await created.connect();
    client = created;
    return created;
  }

  async function dropClient(): Promise<void> {
    const current = client;
    client = null;
    if (!current) {
      return;
    }
    try {
      await current.logout();
    } catch {
      try {
        current.close();
      } catch {
        // Соединение и так нерабочее — глушим ошибку закрытия.
      }
    }
  }

  return {
    async fetchNew({ sinceUid }: { sinceUid?: number; signal?: AbortSignal }): Promise<RawEmail[]> {
      let active: EdgeImapClient;
      try {
        active = await ensureClient();
      } catch (error) {
        await dropClient();
        throw error;
      }

      let lock: { release(): void } | undefined;
      let failed = false;
      try {
        lock = await active.getMailboxLock(mailbox);
        const uidNext = active.mailbox ? active.mailbox.uidNext : undefined;

        // Первый контакт с ящиком: фиксируем базовый UID, историю не принимаем.
        if (sinceUid === undefined && baselineUid === undefined) {
          baselineUid = typeof uidNext === "number" && uidNext > 0 ? uidNext - 1 : 0;
          return [];
        }

        const since = sinceUid ?? baselineUid ?? 0;
        const emails: RawEmail[] = [];
        for await (const message of active.fetch(
          `${since + 1}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          const uid = message.uid;
          // IMAP `N:*` всегда возвращает как минимум последнее письмо — отсекаем «не новые».
          if (!Number.isInteger(uid) || uid <= since || !message.source) {
            continue;
          }
          emails.push(await toRawEmail(uid, message.source));
          if (emails.length >= fetchLimit) {
            break;
          }
        }
        return emails;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        lock?.release();
        if (failed) {
          await dropClient();
        }
      }
    },
  };
}

async function toRawEmail(uid: number, source: Buffer | Uint8Array): Promise<RawEmail> {
  const parsed = await simpleParser(source as Buffer);
  const from = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? undefined;
  const messageId = stripAngleBrackets(parsed.messageId);
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const attachments = (parsed.attachments ?? []).map(toRawAttachment);

  return {
    uid,
    ...(messageId ? { message_id: messageId } : {}),
    ...(from ? { from } : {}),
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(html ? { html } : {}),
    ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function toRawAttachment(attachment: {
  filename?: string;
  contentId?: string;
  contentType?: string;
  size?: number;
}): RawEmailAttachment {
  return {
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.contentId ? { content_id: stripAngleBrackets(attachment.contentId) } : {}),
    mime: attachment.contentType ?? "application/octet-stream",
    ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
  };
}

function extractImapEndpoint(credentials: unknown): EdgeImapEndpointCredentials {
  const imap = (credentials as { imap?: Partial<EdgeImapEndpointCredentials> } | null | undefined)
    ?.imap;
  if (
    !imap ||
    typeof imap.host !== "string" ||
    imap.host.trim() === "" ||
    typeof imap.username !== "string" ||
    typeof imap.password !== "string"
  ) {
    throw new TypeError("IMAP credentials require imap.host, imap.username and imap.password");
  }
  return imap as EdgeImapEndpointCredentials;
}

function stripAngleBrackets(value?: string | false | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function defaultImapClientFactory(config: ImapClientConfig): EdgeImapClient {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    logger: false,
  }) as unknown as EdgeImapClient;
}
