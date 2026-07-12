/**
 * M1 verify (docs/plan/mail-service-selfhosted.md): сквозная проверка боевых
 * IMAP/SMTP-клиентов Edge против реального почтовика на настоящих сокетах.
 *
 * Использует ровно те модули, что и рантайм:
 *   - `createEdgeEmailSender` + `createNodemailerTransport` — отправка по SMTP;
 *   - `createImapMailbox` (imapflow) — приём по IMAP.
 *
 * Отправляет письмо MAIL_USER → MAIL_TO с уникальной темой и ждёт, пока оно
 * появится в ящике получателя (IMAP_USER) по IMAP. PASS → exit 0.
 *
 * Запуск (из контейнера edge-gateway, в одной docker-сети с mailserver):
 *   node --import tsx scripts/verify-email-roundtrip.ts
 * Переменные — см. deploy/mail/README.md.
 */
import { createEdgeEmailSender } from "../src/edge-email-sender.js";
import { createImapMailbox } from "../src/edge-imap-mailbox.js";
import { createNodemailerTransport } from "../src/edge-smtp-transport.js";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const host = env("MAIL_HOST", "mailserver");
  const smtpPort = Number(env("MAIL_SMTP_PORT", "587"));
  const imapPort = Number(env("MAIL_IMAP_PORT", "993"));
  // implicit TLS (993) vs STARTTLS (143). Почтовик без SSL_TYPE отдаёт только
  // STARTTLS-порты 143/587 → на стенде MAIL_IMAP_TLS=0, порт 143.
  const imapTls = (process.env.MAIL_IMAP_TLS ?? "1").trim() !== "0";
  const smtpUser = env("MAIL_USER");
  const smtpPass = env("MAIL_PASS");
  const to = env("MAIL_TO");
  const imapUser = env("IMAP_USER", to);
  const imapPass = env("IMAP_PASS", smtpPass);
  const rejectUnauthorized = (process.env.EMAIL_TLS_REJECT_UNAUTHORIZED ?? "1").trim() !== "0";
  const timeoutMs = Number(env("VERIFY_TIMEOUT_MS", "60000"));

  const marker = `m1-verify-${Date.now()}`;
  const subject = `M1 verify ${marker}`;

  console.log(
    `[verify] host=${host} smtp=${smtpPort} imap=${imapPort} from=${smtpUser} to=${to} ` +
      `imapUser=${imapUser} rejectUnauthorized=${rejectUnauthorized}`,
  );

  // 1) IMAP-ящик получателя + baseline (историю драйвер не принимает — сначала
  //    фиксируем базовый UID, чтобы поймать именно новое письмо).
  const mailbox = createImapMailbox(
    {
      credentials: {
        imap: { host, port: imapPort, tls: imapTls, username: imapUser, password: imapPass },
      },
      channel: { channelId: "verify", organizationId: "verify" },
    },
    { tlsRejectUnauthorized: rejectUnauthorized },
  );
  await mailbox.fetchNew({});
  console.log("[verify] IMAP baseline established");

  // 2) Отправка по SMTP боевым nodemailer-транспортом.
  const sender = createEdgeEmailSender({
    createTransport: ({ smtp }) => createNodemailerTransport({ smtp }, { rejectUnauthorized }),
  });
  const sent = await sender.send({
    organization_id: "verify",
    message_id: marker,
    channel_id: "verify",
    channel_type: "email",
    recipient_ref: to,
    from: smtpUser,
    subject,
    text: `M1 round-trip probe ${marker}`,
    credentials: {
      smtp: { host, port: smtpPort, username: smtpUser, password: smtpPass },
      from_email: smtpUser,
    },
  });
  console.log(`[verify] SMTP send ok, external_message_id=${sent.external_message_id}`);

  // 3) Ждём появления письма в ящике получателя по IMAP.
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const emails = await mailbox.fetchNew({});
    const hit = emails.find((e) => (e.subject ?? "").includes(marker));
    if (hit) {
      console.log(
        `[verify] IMAP received after ${attempts} poll(s): uid=${hit.uid} ` +
          `subject="${hit.subject}" from=${hit.from} message_id=${hit.message_id ?? "-"}`,
      );
      console.log("M1 VERIFY: PASS");
      return;
    }
    await sleep(3000);
  }

  throw new Error(`Email with marker ${marker} not received within ${timeoutMs}ms`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("M1 VERIFY: FAIL —", error instanceof Error ? error.message : error);
    process.exit(1);
  });
