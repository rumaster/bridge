/**
 * M1.5 verify: полный рантайм-путь edge-owned email с EDGE_CHANNEL_DRIVERS=on.
 *
 * Скрипт играет роль App-стороны (которую в бою будет исполнять backend через
 * туннель) и шлёт control-сообщения в HTTP-intake работающего edge-gateway
 * (`POST /internal/edge/control/messages`), а затем проверяет обе стороны:
 *
 *   1) channel_credentials_sync — синхронизация email-кред канала на Edge;
 *      после неё запущенный EdgeEmailInboundDriver начинает поллить IMAP.
 *   2) ВХОДЯЩЕЕ — присылаем письмо client@ → support@ (полит драйвером);
 *      драйвер должен забрать его по IMAP и положить RF-first в буфер
 *      (наблюдается снаружи: edge_message_buffer в postgres-rf).
 *   3) ИСХОДЯЩЕЕ — egress_dispatch → control-plane → EdgeEmailSender (nodemailer)
 *      → SMTP; проверяем, что письмо реально пришло в ящик client@ по IMAP.
 *
 * Всё гоняется реальными сокетами против mailserver в docker-сети RF-кластера.
 */
import { createEdgeControlMessage } from "../../../packages/contracts/src/c9.js";
import { createImapMailbox } from "../src/edge-imap-mailbox.js";
import { createNodemailerTransport } from "../src/edge-smtp-transport.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${name}`);
  }
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postControl(edgeUrl: string, message: unknown): Promise<any> {
  const res = await fetch(`${edgeUrl}/internal/edge/control/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const edgeUrl = env("EDGE_URL", "http://127.0.0.1:3000");
  const host = env("MAIL_HOST", "mailserver");
  const smtpPort = Number(env("MAIL_SMTP_PORT", "587"));
  const imapPort = Number(env("MAIL_IMAP_PORT", "143"));
  const imapTls = (process.env.MAIL_IMAP_TLS ?? "0").trim() !== "0";
  const rejectUnauthorized = (process.env.EMAIL_TLS_REJECT_UNAUTHORIZED ?? "0").trim() !== "0";

  const support = env("SUPPORT_USER", "support@lissac-games.online");
  const supportPass = env("SUPPORT_PASS");
  const client = env("CLIENT_USER", "client@lissac-games.online");
  const clientPass = env("CLIENT_PASS");

  // Реальные org/channel из backend (Demo Organization + засеянный email-канал) —
  // чтобы ядро разрезолвило ингест и довело письмо до менеджера. Дефолты —
  // синтетические (для изолированной проверки драйверов без backend).
  const org = env("ORG_ID", "full-path-org");
  const channel = env("CHANNEL_ID", "full-path-email-chan");
  const stamp = Date.now();

  // Структурные креды канала = ящик support@ (его поллит драйвер, туда пишут клиенты).
  const credentials = {
    imap: { host, port: imapPort, tls: imapTls, username: support, password: supportPass },
    smtp: { host, port: smtpPort, username: support, password: supportPass },
    from_email: support,
  };

  // 1) creds-sync (App → Edge).
  console.log("[full-path] 1) channel_credentials_sync …");
  const sync = await postControl(
    edgeUrl,
    createEdgeControlMessage({
      type: "channel_credentials_sync",
      organizationId: org,
      controlId: `sync-${stamp}`,
      issuedAt: new Date().toISOString(),
      payload: { channel_id: channel, channel_type: "email", credentials, config: {} },
    }),
  );
  console.log(`   → HTTP ${sync.status}, ack.status=${sync.body?.status}`);
  if (sync.status !== 202 || sync.body?.status !== "stored") {
    throw new Error(`creds-sync failed: ${JSON.stringify(sync)}`);
  }

  // IMAP-baseline ящика client@ ДО отправки исходящего — иначе ответ придёт
  // раньше baseline и будет засчитан как «история» (ложно-отрицательный).
  const clientMailbox = createImapMailbox(
    {
      credentials: { imap: { host, port: imapPort, tls: imapTls, username: client, password: clientPass } },
      channel: { channelId: "verify", organizationId: "verify" },
    },
    { tlsRejectUnauthorized: rejectUnauthorized },
  );
  await clientMailbox.fetchNew({}); // baseline client@ до любых отправок ему

  // Дать драйверу обнаружить канал и установить IMAP-baseline до входящего письма.
  console.log("[full-path] waiting for driver discovery + IMAP baseline (14s) …");
  await sleep(14000);

  // 2) ВХОДЯЩЕЕ: client@ → support@ (драйвер должен забрать по IMAP).
  const inboundSubject = `full-path INBOUND ${stamp}`;
  console.log(`[full-path] 2) sending inbound ${client} → ${support} …`);
  const inboundTransport = createNodemailerTransport(
    { smtp: { host, port: smtpPort, username: client, password: clientPass } },
    { rejectUnauthorized },
  );
  await inboundTransport.sendMail({
    from: client,
    to: support,
    subject: inboundSubject,
    text: `inbound probe ${stamp}`,
    messageId: `<inbound-${stamp}@lissac-games.online>`,
  });
  console.log("   → inbound delivered to support@ (driver will ingest → RF buffer)");

  // 3) ИСХОДЯЩЕЕ: egress_dispatch → control-plane → SMTP (support@ → client@).
  const outboundSubject = `full-path OUTBOUND ${stamp}`;
  console.log("[full-path] 3) egress_dispatch (support@ → client@) …");
  const egress = await postControl(
    edgeUrl,
    createEdgeControlMessage({
      type: "egress_dispatch",
      organizationId: org,
      controlId: `egress-${stamp}`,
      issuedAt: new Date().toISOString(),
      payload: {
        message_id: `reply-${stamp}`,
        channel_id: channel,
        channel_type: "email",
        recipient_ref: client,
        from: support,
        subject: outboundSubject,
        text: `outbound reply ${stamp}`,
      },
    }),
  );
  console.log(
    `   → HTTP ${egress.status}, ack.status=${egress.body?.status}, ` +
      `external_message_id=${egress.body?.external_message_id ?? "-"}`,
  );
  if (egress.status !== 202 || egress.body?.status !== "sent") {
    throw new Error(`egress_dispatch failed: ${JSON.stringify(egress)}`);
  }

  // Проверяем, что исходящее реально пришло клиенту (IMAP client@, baseline выше).
  console.log("[full-path] verifying client@ received the outbound reply (IMAP) …");
  const deadline = Date.now() + 45000;
  let received = false;
  while (Date.now() < deadline) {
    const emails = await clientMailbox.fetchNew({});
    if (emails.find((e) => (e.subject ?? "").includes(`OUTBOUND ${stamp}`))) {
      received = true;
      break;
    }
    await sleep(3000);
  }

  console.log("");
  console.log("=== RESULT ===");
  console.log(`creds-sync:      OK (stored)`);
  console.log(`egress ack:      ${egress.body?.status} (external_message_id present)`);
  console.log(`outbound → client: ${received ? "RECEIVED ✅" : "NOT RECEIVED ❌"}`);
  console.log(`inbound marker:  "${inboundSubject}" (проверь RF-буфер postgres-rf)`);
  if (!received) throw new Error("outbound reply not received by client@");
  console.log("M1.5 FULL-PATH (outbound): PASS");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("M1.5 FULL-PATH: FAIL —", e instanceof Error ? e.message : e);
    process.exit(1);
  });
