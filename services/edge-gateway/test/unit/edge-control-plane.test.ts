import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeControlMessage } from "../../../../packages/contracts/src/c9.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";

const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

function credentialsSync(controlId: string, organizationId = "org-1") {
  return createEdgeControlMessage({
    type: "channel_credentials_sync",
    organizationId,
    controlId,
    issuedAt: "2026-07-11T10:00:00.000Z",
    payload: { channel_id: "chan-1", channel_type: "email", credentials: EMAIL_CREDENTIALS },
  });
}

function egressDispatch(controlId: string, organizationId = "org-1") {
  return createEdgeControlMessage({
    type: "egress_dispatch",
    organizationId,
    controlId,
    issuedAt: "2026-07-11T10:00:01.000Z",
    payload: {
      message_id: "msg-1",
      channel_id: "chan-1",
      channel_type: "email",
      recipient_ref: "client@example.com",
      subject: "Re: заявка",
      text: "Ответ менеджера",
    },
  });
}

describe("edge control plane", () => {
  it("stores synced credentials encrypted in memory and resolves them back", async () => {
    const plane = createEdgeControlPlane({ cipher: createRfPayloadCipher({ key: CACHE_KEY }) });

    assert.equal(plane.getEmailCredentials("org-1"), null);
    assert.equal(plane.hasCredentials("org-1"), false);

    const ack = await plane.handle(credentialsSync("ctl-1"));

    assert.equal(ack.accepted, true);
    assert.equal(ack.status, "stored");
    assert.equal(plane.hasCredentials("org-1"), true);
    // Расшифровка из кэша даёт исходные креды (round-trip через RF-cipher).
    assert.deepEqual(plane.getEmailCredentials("org-1"), EMAIL_CREDENTIALS);
  });

  it("dispatches egress through the injected sender and reports sent status", async () => {
    const sent: any[] = [];
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: {
        async send(delivery) {
          sent.push(delivery);
          return { external_message_id: "smtp-42" };
        },
      },
    });

    await plane.handle(credentialsSync("ctl-creds"));
    const ack = await plane.handle(egressDispatch("ctl-egress"));

    assert.equal(ack.status, "sent");
    assert.equal(ack.external_message_id, "smtp-42");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].recipient_ref, "client@example.com");
    // Отправителю передаются разрешённые креды организации из кэша Edge.
    assert.deepEqual(sent[0].credentials, EMAIL_CREDENTIALS);
  });

  it("reports failed status when the sender throws, without throwing", async () => {
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: {
        async send() {
          throw new Error("SMTP 550 mailbox unavailable");
        },
      },
    });

    const ack = await plane.handle(egressDispatch("ctl-egress"));

    assert.equal(ack.accepted, true);
    assert.equal(ack.status, "failed");
    assert.match(ack.detail ?? "", /550/);
  });

  it("reports failed status when no sender is configured on Edge", async () => {
    const plane = createEdgeControlPlane({ cipher: createRfPayloadCipher({ key: CACHE_KEY }) });

    const ack = await plane.handle(egressDispatch("ctl-egress"));

    assert.equal(ack.status, "failed");
    assert.match(ack.detail ?? "", /No email sender/);
  });

  it("deduplicates repeated control_id (idempotency across reconnects)", async () => {
    let sends = 0;
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: {
        async send() {
          sends += 1;
          return { external_message_id: `smtp-${sends}` };
        },
      },
    });

    const first = await plane.handle(egressDispatch("ctl-egress"));
    const second = await plane.handle(egressDispatch("ctl-egress"));

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.external_message_id, first.external_message_id);
    assert.equal(sends, 1, "sender must run once for a repeated control_id");
  });

  it("throws on an invalid control message", async () => {
    const plane = createEdgeControlPlane({ cipher: createRfPayloadCipher({ key: CACHE_KEY }) });

    await assert.rejects(
      () => plane.handle({ contract: "C9.EdgeControlMessage", type: "egress_dispatch" }),
      /Invalid C9 control message/,
    );
  });
});

const MAX_CREDENTIALS = { token: "max-bot-token-org-1" };

function maxCredentialsSync(controlId: string, organizationId = "org-1") {
  return createEdgeControlMessage({
    type: "channel_credentials_sync",
    organizationId,
    controlId,
    issuedAt: "2026-07-12T10:00:00.000Z",
    payload: { channel_id: "chan-max", channel_type: "max", credentials: MAX_CREDENTIALS },
  });
}

function maxEgressDispatch(controlId: string, organizationId = "org-1") {
  return createEdgeControlMessage({
    type: "egress_dispatch",
    organizationId,
    controlId,
    issuedAt: "2026-07-12T10:00:01.000Z",
    payload: {
      message_id: "reply-max-1",
      channel_id: "chan-max",
      channel_type: "max",
      recipient_ref: "chat-max-1",
      text: "Ответ в MAX",
    },
  });
}

describe("edge control plane — MAX channel (M4)", () => {
  it("keeps email and MAX credentials separate for the same org (no collision)", async () => {
    const plane = createEdgeControlPlane({ cipher: createRfPayloadCipher({ key: CACHE_KEY }) });

    await plane.handle(credentialsSync("ctl-email"));
    await plane.handle(maxCredentialsSync("ctl-max"));

    assert.deepEqual(plane.getChannelCredentials("org-1", "email"), EMAIL_CREDENTIALS);
    assert.deepEqual(plane.getChannelCredentials("org-1", "max"), MAX_CREDENTIALS);
    // Обратно-совместимый алиас продолжает отдавать именно email-креды.
    assert.deepEqual(plane.getEmailCredentials("org-1"), EMAIL_CREDENTIALS);
    assert.equal(plane.hasCredentials("org-1", "max"), true);
    assert.equal(plane.hasCredentials("org-1", "sms"), false);
  });

  it("routes MAX egress to the maxSender with the org's MAX credentials", async () => {
    const maxSent: any[] = [];
    const emailSent: any[] = [];
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: {
        async send(delivery) {
          emailSent.push(delivery);
          return { external_message_id: "smtp-1" };
        },
      },
      maxSender: {
        async send(delivery) {
          maxSent.push(delivery);
          return { external_message_id: "max-out-1" };
        },
      },
    });

    await plane.handle(maxCredentialsSync("ctl-max-creds"));
    const ack = await plane.handle(maxEgressDispatch("ctl-max-egress"));

    assert.equal(ack.status, "sent");
    assert.equal(ack.external_message_id, "max-out-1");
    assert.equal(maxSent.length, 1);
    assert.equal(emailSent.length, 0, "email sender must not receive a MAX dispatch");
    assert.equal(maxSent[0].recipient_ref, "chat-max-1");
    assert.deepEqual(maxSent[0].credentials, MAX_CREDENTIALS);
  });

  it("reports failed when no MAX sender is configured", async () => {
    const plane = createEdgeControlPlane({ cipher: createRfPayloadCipher({ key: CACHE_KEY }) });

    const ack = await plane.handle(maxEgressDispatch("ctl-max-egress"));

    assert.equal(ack.status, "failed");
    assert.match(ack.detail ?? "", /No MAX sender/);
  });
});
