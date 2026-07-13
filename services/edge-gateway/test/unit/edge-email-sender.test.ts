import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeControlMessage } from "../../../../packages/contracts/src/c9.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createEdgeEmailSender, EdgeEmailSenderError } from "../../src/edge-email-sender.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";

const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");

const CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
  from_name: "Служба поддержки",
};

/** Собирает fake SMTP-транспорт, фиксирующий отправленные письма. */
function createFakeTransportFactory() {
  const created: any[] = [];
  const sent: any[] = [];
  const factory = ({ smtp }: any) => {
    created.push(smtp);
    return {
      async sendMail(message: any) {
        sent.push(message);
        return { messageId: message.messageId };
      },
    };
  };
  return { factory, created, sent };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: "org-1",
    message_id: "msg-1",
    channel_id: "chan-1",
    channel_type: "email",
    recipient_ref: "client@example.com",
    subject: "Re: заявка",
    text: "Ответ менеджера",
    credentials: CREDENTIALS,
    ...overrides,
  };
}

describe("edge email sender (SMTP egress)", () => {
  it("builds a correct MIME message and returns an external id", async () => {
    const { factory, sent } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    const result = await sender.send(delivery() as any);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "client@example.com");
    assert.equal(sent[0].from, '"Служба поддержки" <support@example.com>');
    assert.equal(sent[0].subject, "Re: заявка");
    assert.equal(sent[0].text, "Ответ менеджера");
    assert.match(sent[0].messageId, /^<.+@example\.com>$/);
    assert.equal(result.external_message_id, sent[0].messageId);
  });

  it("passes threading headers (In-Reply-To / References)", async () => {
    const { factory, sent } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    await sender.send(
      delivery({ in_reply_to: "<orig@mail>", references: ["<a@mail>", "<orig@mail>"] }) as any,
    );

    assert.equal(sent[0].inReplyTo, "<orig@mail>");
    assert.deepEqual(sent[0].references, ["<a@mail>", "<orig@mail>"]);
  });

  it("defaults From to the org credentials when delivery.from is absent", async () => {
    const { factory, sent } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    await sender.send(delivery({ credentials: { ...CREDENTIALS, from_name: undefined } }) as any);

    assert.equal(sent[0].from, "support@example.com");
  });

  it("uses a deterministic Message-ID for idempotent retries", async () => {
    const { factory, sent } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    await sender.send(delivery() as any);
    await sender.send(delivery() as any);

    assert.equal(sent[0].messageId, sent[1].messageId);
  });

  it("caches an SMTP transport per organization config", async () => {
    const { factory, created } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    await sender.send(delivery() as any);
    await sender.send(delivery({ message_id: "msg-2" }) as any);

    assert.equal(created.length, 1, "same SMTP config must reuse one transport");
  });

  it("throws when there is no recipient or no SMTP credentials", async () => {
    const { factory } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    await assert.rejects(() => sender.send(delivery({ recipient_ref: "" }) as any), EdgeEmailSenderError);
    await assert.rejects(() => sender.send(delivery({ credentials: null }) as any), EdgeEmailSenderError);
  });

  it("plugs into the control-plane egress_dispatch and reports sent (end-to-end)", async () => {
    const { factory, sent } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: sender,
    });

    // Синхронизируем креды (E2), затем диспетчеризуем отправку (E4).
    await plane.handle(
      createEdgeControlMessage({
        type: "channel_credentials_sync",
        organizationId: "org-1",
        controlId: "ctl-creds",
        issuedAt: "2026-07-11T10:00:00.000Z",
        payload: { channel_id: "chan-1", channel_type: "email", credentials: CREDENTIALS },
      }),
    );

    const egress = createEdgeControlMessage({
      type: "egress_dispatch",
      organizationId: "org-1",
      controlId: "ctl-egress",
      issuedAt: "2026-07-11T10:00:01.000Z",
      payload: {
        message_id: "msg-1",
        channel_id: "chan-1",
        channel_type: "email",
        recipient_ref: "client@example.com",
        subject: "Re: заявка",
        text: "Ответ",
      },
    });

    const ack = await plane.handle(egress);
    assert.equal(ack.status, "sent");
    assert.equal(ack.external_message_id, sent[0].messageId);
    // Отправителю доехали креды организации из кэша (SMTP host).
    assert.equal(sent.length, 1);

    // Повтор egress_dispatch по тому же control_id не шлёт письмо второй раз.
    const dupe = await plane.handle(egress);
    assert.equal(dupe.duplicate, true);
    assert.equal(sent.length, 1);
  });

  it("warmUp прогревает транспорт через verify() и переиспользует его при отправке (§4.6)", async () => {
    const created: any[] = [];
    const verified: any[] = [];
    const factory = ({ smtp }: any) => {
      created.push(smtp);
      return {
        async sendMail(message: any) {
          return { messageId: message.messageId };
        },
        async verify() {
          verified.push(smtp);
        },
      };
    };
    const sender = createEdgeEmailSender({ createTransport: factory });

    const ok = await sender.warmUp(CREDENTIALS);
    assert.equal(ok, true);
    assert.equal(created.length, 1);
    assert.equal(verified.length, 1, "verify() должен подняться заранее (прогрев)");
    assert.equal(sender.getMetrics().warmed_total, 1);

    // Отправка после прогрева переиспользует тот же (тёплый) транспорт.
    await sender.send(delivery() as any);
    assert.equal(created.length, 1, "send переиспользует прогретый транспорт");
  });

  it("warmUp best-effort: ошибка verify() не пробрасывается, а гасится в false", async () => {
    const factory = () => ({
      async sendMail(message: any) {
        return { messageId: message.messageId };
      },
      async verify() {
        throw new Error("SMTP недоступен");
      },
    });
    const sender = createEdgeEmailSender({ createTransport: factory });

    assert.equal(await sender.warmUp(CREDENTIALS), false);
    assert.equal(sender.getMetrics().warm_failed_total, 1);
  });

  it("warmUp — no-op без SMTP-кред (транспорт не создаётся)", async () => {
    const { factory, created } = createFakeTransportFactory();
    const sender = createEdgeEmailSender({ createTransport: factory });

    assert.equal(await sender.warmUp(null), false);
    assert.equal(await sender.warmUp({ from_email: "x@y.z" }), false);
    assert.equal(created.length, 0);
  });

  it("control-plane прогревает транспорт при channel_credentials_sync (email), не блокируя ack", async () => {
    const verified: any[] = [];
    const factory = ({ smtp }: any) => ({
      async sendMail(message: any) {
        return { messageId: message.messageId };
      },
      async verify() {
        verified.push(smtp);
      },
    });
    const sender = createEdgeEmailSender({ createTransport: factory });
    const plane = createEdgeControlPlane({
      cipher: createRfPayloadCipher({ key: CACHE_KEY }),
      emailSender: sender,
    });

    const ack = await plane.handle(
      createEdgeControlMessage({
        type: "channel_credentials_sync",
        organizationId: "org-1",
        controlId: "ctl-creds-warm",
        issuedAt: "2026-07-11T10:00:00.000Z",
        payload: { channel_id: "chan-1", channel_type: "email", credentials: CREDENTIALS },
      }),
    );
    // Прогрев — fire-and-forget: ack не ждёт verify().
    assert.equal(ack.status, "stored");
    // Даём отработать отложенному warmUp.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(verified.length, 1, "синхронизация email-кред должна прогреть SMTP-транспорт");
  });
});
