import type { EdgeImapClient, ImapClientConfig } from "./edge-imap-mailbox.js";
import type { EdgeSmtpConfig } from "./edge-email-sender.js";

/**
 * Проверка подключения email-канала на Edge Gateway (Этап E1 плана
 * `docs/plan/email-channel-production.md`). Реализует сеам `channel_test`
 * control-plane (E2): по запросу от backend выполняет **реальную** проверку кред —
 * IMAP LOGIN (connect+logout) и SMTP verify (EHLO+AUTH, без отправки письма) —
 * теми же боевыми клиентами (`imapflow`/`nodemailer`), что и приём/отправка, и с
 * той же стороны РФ-контура. Так невалидные креды (обычный пароль вместо
 * app-password, закрытый порт, неверный хост) дают честный `error+причину`, а не
 * обобщённый `connected`.
 *
 * Пробы инъектируются (`probeImap`/`probeSmtp`), поэтому unit-тесты гоняют логику
 * без реальных сокетов, а в рантайме подставляются боевые клиенты
 * ([`createEdgeChannelRuntime`](./edge-channel-drivers.ts)). Обе пробы выполняются
 * независимо: сбой одной не маскирует результат другой — в `detail` попадают обе
 * причины.
 */

/** Креды одного IMAP-эндпоинта (подмножество EmailChannelCredentials.imap). */
interface ImapEndpoint {
  host: string;
  port?: number;
  tls?: boolean;
  username: string;
  password: string;
}

export interface EdgeChannelProbeResult {
  ok: boolean;
  detail?: string;
}

export interface EdgeChannelTestResult {
  ok: boolean;
  imap: EdgeChannelProbeResult;
  smtp: EdgeChannelProbeResult;
  /** Сводная причина отказа (пусто при ok). */
  detail?: string;
}

export interface EdgeChannelTesterProbes {
  /** Проба IMAP LOGIN: connect+logout; бросает при отказе. */
  probeImap: (config: ImapClientConfig) => Promise<void>;
  /** Проба SMTP EHLO+AUTH (verify); бросает при отказе. */
  probeSmtp: (input: { smtp: EdgeSmtpConfig }) => Promise<void>;
}

export interface EdgeChannelTester {
  test(input: { credentials: unknown; channelType: string }): Promise<EdgeChannelTestResult>;
}

export function createEdgeEmailTester({
  probeImap,
  probeSmtp,
}: EdgeChannelTesterProbes): EdgeChannelTester {
  if (typeof probeImap !== "function" || typeof probeSmtp !== "function") {
    throw new TypeError("probeImap and probeSmtp are required");
  }

  return {
    async test({ credentials, channelType }) {
      if (channelType !== "email") {
        const detail = `Проверка канала типа «${channelType}» на Edge не поддерживается`;
        return {
          ok: false,
          imap: { ok: false, detail },
          smtp: { ok: false, detail },
          detail,
        };
      }

      const creds = credentials as { imap?: ImapEndpoint; smtp?: EdgeSmtpConfig } | null | undefined;

      const imap = await runProbe(async () => {
        const endpoint = requireImap(creds?.imap);
        await probeImap({
          host: endpoint.host,
          port: endpoint.port ?? 993,
          secure: endpoint.tls ?? true,
          auth: { user: endpoint.username, pass: endpoint.password },
        });
      });

      const smtp = await runProbe(async () => {
        const endpoint = requireSmtp(creds?.smtp);
        await probeSmtp({ smtp: endpoint });
      });

      const ok = imap.ok && smtp.ok;
      return {
        ok,
        imap,
        smtp,
        ...(ok ? {} : { detail: combineDetail(imap, smtp) }),
      };
    },
  };
}

async function runProbe(probe: () => Promise<void>): Promise<EdgeChannelProbeResult> {
  try {
    await probe();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function combineDetail(imap: EdgeChannelProbeResult, smtp: EdgeChannelProbeResult): string {
  const parts: string[] = [];
  if (!imap.ok) {
    parts.push(`IMAP: ${imap.detail ?? "ошибка"}`);
  }
  if (!smtp.ok) {
    parts.push(`SMTP: ${smtp.detail ?? "ошибка"}`);
  }
  return parts.join("; ") || "Проверка подключения не удалась";
}

function requireImap(imap: ImapEndpoint | undefined): ImapEndpoint {
  if (
    !imap ||
    typeof imap.host !== "string" ||
    imap.host.trim() === "" ||
    typeof imap.username !== "string" ||
    typeof imap.password !== "string"
  ) {
    throw new Error("нет кред IMAP (host/username/password)");
  }
  return imap;
}

function requireSmtp(smtp: EdgeSmtpConfig | undefined): EdgeSmtpConfig {
  if (
    !smtp ||
    typeof smtp.host !== "string" ||
    smtp.host.trim() === "" ||
    typeof smtp.username !== "string" ||
    typeof smtp.password !== "string"
  ) {
    throw new Error("нет кред SMTP (host/username/password)");
  }
  return smtp;
}
