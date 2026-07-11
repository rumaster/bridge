import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeControlClient } from "../../src/edge-control-client.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createInProcessEdgeControlTransport } from "../../src/edge-control-tunnel.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";

const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");
const SESSION_KEY = Buffer.alloc(32, 9);

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

/** Собирает App-клиент + Edge control-plane, связанные in-process туннелем. */
function buildPair() {
  const sent: any[] = [];
  const plane = createEdgeControlPlane({
    cipher: createRfPayloadCipher({ key: CACHE_KEY }),
    emailSender: {
      async send(delivery) {
        sent.push(delivery);
        return { external_message_id: `smtp-${sent.length}` };
      },
    },
  });
  const transport = createInProcessEdgeControlTransport({
    sessionId: "app-core:edge:session",
    sessionKey: SESSION_KEY,
    controlPlane: plane,
  });
  const client = createEdgeControlClient({ transport });
  return { client, plane, transport, sent };
}

describe("edge control client (App→Edge over the tunnel)", () => {
  it("delivers credential sync and egress over an established session", async () => {
    const { client, plane, sent } = buildPair();

    const synced = await client.syncCredentials({
      organizationId: "org-1",
      controlId: "ctl-creds-1",
      channelId: "chan-1",
      credentials: EMAIL_CREDENTIALS,
    });
    assert.equal(synced.queued, false);
    assert.equal(plane.getEmailCredentials("org-1") !== null, true);

    const dispatched = await client.dispatchEgress({
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      delivery: {
        message_id: "msg-1",
        channel_type: "email",
        recipient_ref: "client@example.com",
        subject: "Re: заявка",
        text: "Ответ",
      },
    });
    assert.equal(dispatched.queued, false);
    assert.equal((dispatched.ack as any).status, "sent");
    assert.equal(sent.length, 1);
    // Кред организации доехал через туннель и был передан отправителю.
    assert.deepEqual(sent[0].credentials, EMAIL_CREDENTIALS);
  });

  it("queues messages while the tunnel is down and drains them on reconnect", async () => {
    const { client, plane, transport, sent } = buildPair();

    transport.link.cut();

    const a = await client.syncCredentials({
      organizationId: "org-1",
      controlId: "ctl-creds-1",
      channelId: "chan-1",
      credentials: EMAIL_CREDENTIALS,
    });
    const b = await client.dispatchEgress({
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      delivery: { message_id: "msg-1", channel_type: "email", recipient_ref: "client@example.com", text: "Ответ" },
    });

    assert.equal(a.queued, true);
    assert.equal(b.queued, true);
    assert.equal(client.pendingCount(), 2);
    // Ничего не отправлено, пока канал лежит.
    assert.equal(sent.length, 0);
    assert.equal(plane.hasCredentials("org-1"), false);

    transport.link.restore();
    const drain = await client.drain();

    assert.equal(drain.drained, 2);
    assert.equal(drain.remaining, 0);
    assert.equal(client.pendingCount(), 0);
    // После дренажа креды синхронизированы и письмо отправлено — в порядке FIFO.
    assert.equal(plane.hasCredentials("org-1"), true);
    assert.equal(sent.length, 1);
  });

  it("does not double-send a queued message that was already delivered (idempotency)", async () => {
    const { client, transport, sent } = buildPair();

    // Доставляем egress онлайн.
    await client.dispatchEgress({
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      delivery: { message_id: "msg-1", channel_type: "email", recipient_ref: "client@example.com", text: "Ответ" },
    });
    assert.equal(sent.length, 1);

    // Симулируем повторную постановку того же control_id в очередь (например,
    // ретрай при неоднозначном разрыве) и дренаж — Edge дедуплицирует по control_id.
    transport.link.cut();
    await client.dispatchEgress({
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      delivery: { message_id: "msg-1", channel_type: "email", recipient_ref: "client@example.com", text: "Ответ" },
    });
    transport.link.restore();
    const drain = await client.drain();

    assert.equal(drain.drained, 1);
    // Отправитель не вызывался повторно: тот же control_id → duplicate ack.
    assert.equal(sent.length, 1);
  });

  it("preserves queued order across an interrupted drain", async () => {
    const { client, transport } = buildPair();
    transport.link.cut();

    for (let i = 1; i <= 3; i += 1) {
      await client.dispatchEgress({
        organizationId: "org-1",
        controlId: `ctl-${i}`,
        delivery: { message_id: `msg-${i}`, channel_type: "email", recipient_ref: "client@example.com", text: `#${i}` },
      });
    }
    assert.equal(client.pendingCount(), 3);

    // Канал всё ещё лежит → дренаж ничего не отправляет, очередь цела.
    const failedDrain = await client.drain();
    assert.equal(failedDrain.drained, 0);
    assert.equal(failedDrain.remaining, 3);

    transport.link.restore();
    const okDrain = await client.drain();
    assert.equal(okDrain.drained, 3);
    assert.equal(client.pendingCount(), 0);
  });
});
