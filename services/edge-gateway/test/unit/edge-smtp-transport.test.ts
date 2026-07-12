import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeEmailSender } from "../../src/edge-email-sender.js";
import { createNodemailerTransport, type NodemailerLike } from "../../src/edge-smtp-transport.js";

/**
 * Боевой nodemailer-транспорт Edge (Этап M1): проверяем маппинг EdgeSmtpMessage →
 * nodemailer sendMail, выбор secure по порту, проброс TLS rejectUnauthorized и
 * ленивую инициализацию транспорта. nodemailer инъектируется через `load`.
 */

function fakeNodemailer() {
  const created: any[] = [];
  const sent: any[] = [];
  const nodemailer: NodemailerLike = {
    createTransport(options: unknown) {
      created.push(options);
      return {
        async sendMail(message: unknown) {
          sent.push(message);
          return { messageId: "<server-assigned@mailserver>" };
        },
      };
    },
  };
  return { nodemailer, created, sent };
}

describe("edge nodemailer transport (M1)", () => {
  it("maps message fields and returns the server messageId", async () => {
    const { nodemailer, created, sent } = fakeNodemailer();
    const transport = createNodemailerTransport(
      { smtp: { host: "mailserver", port: 587, username: "support@x.io", password: "secret" } },
      { rejectUnauthorized: false, load: async () => nodemailer },
    );

    const result = await transport.sendMail({
      from: "support@x.io",
      to: "client@x.io",
      subject: "Re: заказ",
      text: "готово",
      messageId: "<reply-1@x.io>",
      inReplyTo: "<orig-1@x.io>",
      references: ["<orig-1@x.io>"],
    });

    assert.equal(result.messageId, "<server-assigned@mailserver>");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      from: "support@x.io",
      to: "client@x.io",
      subject: "Re: заказ",
      text: "готово",
      messageId: "<reply-1@x.io>",
      inReplyTo: "<orig-1@x.io>",
      references: ["<orig-1@x.io>"],
    });
    // secure=false для 587 (STARTTLS), rejectUnauthorized проброшен.
    assert.equal(created[0].secure, false);
    assert.equal(created[0].port, 587);
    assert.deepEqual(created[0].tls, { rejectUnauthorized: false });
    assert.deepEqual(created[0].auth, { user: "support@x.io", pass: "secret" });
  });

  it("uses implicit TLS (secure=true) for port 465 and lazily creates one transport", async () => {
    const { nodemailer, created } = fakeNodemailer();
    const transport = createNodemailerTransport(
      { smtp: { host: "mailserver", port: 465, username: "u", password: "p" } },
      { load: async () => nodemailer },
    );

    assert.equal(created.length, 0, "transport not created until first send (lazy)");
    await transport.sendMail({ from: "u@x.io", to: "c@x.io", subject: "s", text: "t", messageId: "<1@x.io>" });
    await transport.sendMail({ from: "u@x.io", to: "c@x.io", subject: "s2", text: "t2", messageId: "<2@x.io>" });
    assert.equal(created.length, 1, "transport reused across sends");
    assert.equal(created[0].secure, true);
    assert.deepEqual(created[0].tls, { rejectUnauthorized: true }, "strict TLS by default");
  });

  it("integrates with the edge email sender end-to-end (egress → nodemailer)", async () => {
    const { nodemailer, sent } = fakeNodemailer();
    const sender = createEdgeEmailSender({
      createTransport: ({ smtp }) => createNodemailerTransport({ smtp }, { load: async () => nodemailer }),
    });

    const ack = await sender.send({
      organization_id: "org-1",
      message_id: "reply-9",
      channel_id: "chan-1",
      channel_type: "email",
      recipient_ref: "client@x.io",
      from: "support@x.io",
      subject: "Ответ",
      text: "текст",
      credentials: { smtp: { host: "mailserver", port: 587, username: "support@x.io", password: "secret" } },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "client@x.io");
    assert.equal(sent[0].from, "support@x.io");
    assert.ok(typeof ack.external_message_id === "string" && ack.external_message_id.length > 0);
  });
});
