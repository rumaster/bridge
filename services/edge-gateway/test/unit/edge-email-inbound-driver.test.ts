import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeCluster } from "../../src/edge-cluster.js";
import { createEdgeEmailInboundDriver } from "../../src/edge-email-inbound-driver.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { VpnTunnelChannelDownError } from "../../src/vpn-tunnel.js";

const RF_KEY = Buffer.alloc(32, 7).toString("base64");
const SILENT = { warn() {}, error() {}, info() {} };
const CREDENTIALS = { imap: { host: "imap.example.com" }, smtp: { host: "smtp.example.com" }, from_email: "support@example.com" };

/** Ломаемый туннель, собирающий пересланные C9-сообщения (как в edge-cluster.test). */
function createFakeTunnel() {
  let up = true;
  const sent: any[] = [];
  return {
    sent,
    isConnected: () => up,
    async ensureConnected() {},
    async send(message: any) {
      if (!up) {
        throw new VpnTunnelChannelDownError("tunnel down");
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

/** Почтовый ящик с ручным наполнением; fetchNew фильтрует по курсору UID. */
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

function textEmail(uid: number, messageId: string, text: string) {
  return { uid, message_id: messageId, from: "client@example.com", subject: "тема", text };
}

describe("edge email inbound driver", () => {
  it("fetches an email and RF-first ingests it through the tunnel", async () => {
    const tunnel = createFakeTunnel();
    const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel });
    const mailbox = createFakeMailbox([textEmail(1, "<m1@mail>", "где заказ?")]);

    const driver = createEdgeEmailInboundDriver({
      listChannels: async () => [{ channelId: "chan-1", organizationId: "org-1" }],
      resolveCredentials: async () => CREDENTIALS,
      createMailbox: () => mailbox,
      ingest: (body) => edgeCluster.ingest(body),
      logger: SILENT,
    });

    await driver.refreshChannels();
    const ingested = await driver.pollChannelOnce("chan-1");

    assert.equal(ingested, 1);
    assert.equal(tunnel.sent.length, 1);
    const payload = tunnel.sent[0].payload;
    assert.equal(payload.contract, "C2.IngressMessage");
    assert.equal(payload.message.channel_type, "email");
    assert.equal(payload.message.content.text, "где заказ?");
    assert.equal(driver.getMetrics().ingested_total, 1);
  });

  it("deduplicates a repeated Message-ID across polls", async () => {
    const tunnel = createFakeTunnel();
    const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel });
    const mailbox = createFakeMailbox([textEmail(1, "<same@mail>", "первый")]);

    const driver = createEdgeEmailInboundDriver({
      listChannels: async () => [{ channelId: "chan-1", organizationId: "org-1" }],
      resolveCredentials: async () => CREDENTIALS,
      createMailbox: () => mailbox,
      ingest: (body) => edgeCluster.ingest(body),
      logger: SILENT,
    });
    await driver.refreshChannels();
    await driver.pollChannelOnce("chan-1");

    // То же письмо (тот же Message-ID) появляется снова с новым UID.
    mailbox.push(textEmail(2, "<same@mail>", "повтор"));
    await driver.pollChannelOnce("chan-1");

    assert.equal(tunnel.sent.length, 1, "repeated Message-ID must not be ingested twice");
    assert.equal(driver.getMetrics().duplicate_total, 1);
  });

  it("skips a channel whose credentials are not synced yet", async () => {
    const tunnel = createFakeTunnel();
    const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel });

    const driver = createEdgeEmailInboundDriver({
      listChannels: async () => [{ channelId: "chan-1", organizationId: "org-1" }],
      resolveCredentials: async () => null,
      createMailbox: () => createFakeMailbox([textEmail(1, "<m@mail>", "hi")]),
      ingest: (body) => edgeCluster.ingest(body),
      logger: SILENT,
    });
    await driver.refreshChannels();
    const ingested = await driver.pollChannelOnce("chan-1");

    assert.equal(ingested, 0);
    assert.equal(tunnel.sent.length, 0);
    assert.equal(driver.getMetrics().missing_credentials_total, 1);
  });

  it("buffers RF-first while the tunnel is down and forwards on restore (no loss)", async () => {
    const tunnel = createFakeTunnel();
    const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel });
    const mailbox = createFakeMailbox([textEmail(1, "<m1@mail>", "во время блокировки")]);

    const driver = createEdgeEmailInboundDriver({
      listChannels: async () => [{ channelId: "chan-1", organizationId: "org-1" }],
      resolveCredentials: async () => CREDENTIALS,
      createMailbox: () => mailbox,
      ingest: (body) => edgeCluster.ingest(body),
      logger: SILENT,
    });
    await driver.refreshChannels();

    tunnel.cut();
    const ingested = await driver.pollChannelOnce("chan-1");

    // Письмо зафиксировано RF-first, но ещё не переслано (туннель лежит).
    assert.equal(ingested, 1);
    assert.equal(tunnel.sent.length, 0);
    assert.equal(await edgeCluster.pendingCount(), 1);

    tunnel.restore();
    await edgeCluster.drain();

    assert.equal(tunnel.sent.length, 1, "buffered email must be forwarded after reconnect");
    assert.equal(await edgeCluster.pendingCount(), 0);
  });

  it("keeps the cursor on ingest failure so the email is retried", async () => {
    let attempts = 0;
    const mailbox = createFakeMailbox([textEmail(1, "<m1@mail>", "retry me")]);
    const driver = createEdgeEmailInboundDriver({
      listChannels: async () => [{ channelId: "chan-1", organizationId: "org-1" }],
      resolveCredentials: async () => CREDENTIALS,
      createMailbox: () => mailbox,
      ingest: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("RF buffer backpressure");
        }
        return { fixed_in_rf: true, forwarded: true };
      },
      logger: SILENT,
    });
    await driver.refreshChannels();

    const first = await driver.pollChannelOnce("chan-1");
    assert.equal(first, 0);
    assert.equal(driver.getMetrics().ingest_retry_total, 1);

    // Курсор не сдвинулся → то же письмо переотправляется на следующем поллинге.
    const second = await driver.pollChannelOnce("chan-1");
    assert.equal(second, 1);
    assert.equal(attempts, 2);
  });
});
