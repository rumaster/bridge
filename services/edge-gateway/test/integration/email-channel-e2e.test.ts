import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeCluster } from "../../src/edge-cluster.js";
import { createEdgeControlClient } from "../../src/edge-control-client.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createInProcessEdgeControlTransport } from "../../src/edge-control-tunnel.js";
import { createEdgeEmailInboundDriver } from "../../src/edge-email-inbound-driver.js";
import { createEdgeEmailSender } from "../../src/edge-email-sender.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { VpnTunnelChannelDownError } from "../../src/vpn-tunnel.js";

/**
 * Сквозная приёмка email-канала (Этап E6 плана email-channel-production).
 *
 * Собирает воедино модули E2–E5 в детерминированном in-process контуре (уровень
 * зрелости data-plane; реальные IMAP/SMTP-сокеты и межсерверный туннель — веха
 * MP-12) и прогоняет сценарий DoD: синхронизация кред → приём письма (IMAP →
 * RF-first → туннель) → ответ менеджера (egress_dispatch → SMTP, threaded) →
 * отсутствие потерь при разрыве в обе стороны → идемпотентность.
 */

const RF_KEY = Buffer.alloc(32, 7).toString("base64");
const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");
const SESSION_KEY = Buffer.alloc(32, 9);
const ORG = "org-1";
const CHANNEL = "chan-1";
const CLIENT_EMAIL = "client@example.com";
const CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
  from_name: "Служба поддержки",
};

function createFakeDataTunnel() {
  let up = true;
  const sent: any[] = [];
  return {
    sent,
    isConnected: () => up,
    async ensureConnected() {},
    async send(message: any) {
      if (!up) {
        throw new VpnTunnelChannelDownError("data tunnel down");
      }
      sent.push(message);
      return { accepted: true };
    },
    cut() {
      up = false;
    },
    restore() {
      up = true;
    },
  };
}

function createFakeMailbox(initial: any[] = []) {
  const inbox = [...initial];
  return {
    push(...emails: any[]) {
      inbox.push(...emails);
    },
    async fetchNew({ sinceUid }: { sinceUid?: number }) {
      return inbox.filter((email) => sinceUid === undefined || (email.uid ?? 0) > sinceUid);
    },
  };
}

function buildEdgeEmailStack() {
  // Data-plane (Edge→App): RF-first буфер + туннель.
  const dataTunnel = createFakeDataTunnel();
  const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel: dataTunnel });

  // Исходящий SMTP (E4) с fake-транспортом.
  const smtpSent: any[] = [];
  const sender = createEdgeEmailSender({
    createTransport: () => ({
      async sendMail(message: any) {
        smtpSent.push(message);
        return { messageId: message.messageId };
      },
    }),
  });

  // Control-plane (App→Edge): кэш кред + диспетчеризация egress.
  const plane = createEdgeControlPlane({
    cipher: createRfPayloadCipher({ key: CACHE_KEY }),
    emailSender: sender,
  });
  const controlTransport = createInProcessEdgeControlTransport({
    sessionId: "app-core:edge:session",
    sessionKey: SESSION_KEY,
    controlPlane: plane,
  });
  const controlClient = createEdgeControlClient({ transport: controlTransport });

  // Входящий IMAP-драйвер (E3): креды берёт из control-plane кэша.
  const mailbox = createFakeMailbox();
  const driver = createEdgeEmailInboundDriver({
    listChannels: async () => [{ channelId: CHANNEL, organizationId: ORG }],
    resolveCredentials: () => plane.getEmailCredentials(ORG),
    createMailbox: () => mailbox,
    ingest: (body) => edgeCluster.ingest(body),
    logger: { warn() {}, error() {}, info() {} },
  });

  return { dataTunnel, edgeCluster, smtpSent, sender, plane, controlTransport, controlClient, mailbox, driver };
}

describe("email channel end-to-end (E6 acceptance)", () => {
  it("runs the full scenario: creds sync → inbound → reply → no-loss on break → idempotency", async () => {
    const stack = buildEdgeEmailStack();
    const { dataTunnel, edgeCluster, smtpSent, plane, controlTransport, controlClient, mailbox, driver } = stack;
    await driver.refreshChannels();

    // 1. Backend синхронизирует креды на Edge (E2).
    const synced = await controlClient.syncCredentials({
      organizationId: ORG,
      controlId: "ctl-creds-1",
      channelId: CHANNEL,
      credentials: CREDENTIALS,
    });
    assert.equal(synced.queued, false);
    assert.equal(plane.hasCredentials(ORG), true);

    // 2. Входящее: письмо клиента забирается по IMAP, RF-first, через туннель (E3).
    mailbox.push({ uid: 1, message_id: "<orig@mail>", from: CLIENT_EMAIL, subject: "Вопрос", text: "где заказ?" });
    await driver.pollChannelOnce(CHANNEL);

    assert.equal(dataTunnel.sent.length, 1);
    const inbound = dataTunnel.sent[0].payload.message;
    assert.equal(inbound.channel_type, "email");
    assert.equal(inbound.content.text, "где заказ?");
    assert.equal(inbound.sender_ref, CLIENT_EMAIL);
    const inboundMessageIdHeader = inbound.external_message_id;
    assert.equal(inboundMessageIdHeader, "<orig@mail>");

    // 3. Менеджер отвечает: egress_dispatch → SMTP (E4), threaded по Message-ID.
    const dispatched = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-1",
      delivery: {
        message_id: "reply-1",
        channel_id: CHANNEL,
        channel_type: "email",
        recipient_ref: CLIENT_EMAIL,
        subject: "Re: Вопрос",
        text: "Заказ отправлен",
        in_reply_to: inboundMessageIdHeader,
      },
    });
    assert.equal((dispatched.ack as any).status, "sent");
    assert.equal(smtpSent.length, 1);
    assert.equal(smtpSent[0].to, CLIENT_EMAIL);
    assert.equal(smtpSent[0].from, '"Служба поддержки" <support@example.com>');
    assert.equal(smtpSent[0].subject, "Re: Вопрос");
    // Ответ уходит в той же цепочке письма (In-Reply-To = Message-ID входящего).
    assert.equal(smtpSent[0].inReplyTo, "<orig@mail>");

    // 4a. Разрыв туннеля на входящем: письмо RF-first буферизуется, дренажится позже.
    dataTunnel.cut();
    mailbox.push({ uid: 2, message_id: "<second@mail>", from: CLIENT_EMAIL, text: "ещё вопрос" });
    await driver.pollChannelOnce(CHANNEL);
    assert.equal(dataTunnel.sent.length, 1, "buffered RF-first, not forwarded while down");
    assert.equal(await edgeCluster.pendingCount(), 1);
    dataTunnel.restore();
    await edgeCluster.drain();
    assert.equal(dataTunnel.sent.length, 2, "buffered inbound forwarded after reconnect");

    // 4b. Разрыв туннеля на исходящем: egress встаёт в очередь, дренажится позже.
    controlTransport.link.cut();
    const queued = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-2",
      delivery: {
        message_id: "reply-2",
        channel_id: CHANNEL,
        channel_type: "email",
        recipient_ref: CLIENT_EMAIL,
        text: "второй ответ",
      },
    });
    assert.equal(queued.queued, true);
    assert.equal(smtpSent.length, 1, "not sent while control channel down");
    controlTransport.link.restore();
    const drain = await controlClient.drain();
    assert.equal(drain.drained, 1);
    assert.equal(smtpSent.length, 2, "queued reply sent after reconnect");

    // 5. Идемпотентность: повтор egress по тому же control_id не шлёт письмо дважды.
    const dupe = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-1",
      delivery: {
        message_id: "reply-1",
        channel_id: CHANNEL,
        channel_type: "email",
        recipient_ref: CLIENT_EMAIL,
        subject: "Re: Вопрос",
        text: "Заказ отправлен",
      },
    });
    assert.equal((dupe.ack as any).duplicate, true);
    assert.equal(smtpSent.length, 2, "duplicate control_id must not re-send");
  });

  it("gates inbound on credential sync (no creds → channel skipped)", async () => {
    const stack = buildEdgeEmailStack();
    await stack.driver.refreshChannels();

    // Креды ещё не синхронизированы — приём пропускается (нечем подключиться к IMAP).
    stack.mailbox.push({ uid: 1, message_id: "<x@mail>", from: CLIENT_EMAIL, text: "hi" });
    const ingested = await stack.driver.pollChannelOnce(CHANNEL);

    assert.equal(ingested, 0);
    assert.equal(stack.dataTunnel.sent.length, 0);
    assert.equal(stack.driver.getMetrics().missing_credentials_total, 1);
  });
});
