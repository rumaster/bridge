import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createEdgeControlClient } from "../../src/edge-control-client.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createTunnelEdgeControlTransport } from "../../src/edge-control-transport.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { createVpnLink } from "../../src/vpn-tunnel.js";
import {
  createVpnTunnelTcpAppServer,
  createVpnTunnelTcpRemoteServer,
} from "../../src/vpn-transport.js";

const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

/** Edge control-listener: TCP-сервер, чей RPC-эндпоинт оборачивает control-plane. */
function createEdgeControlListener() {
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
  const server = createVpnTunnelTcpAppServer({
    endpoint: { control: (message) => plane.handle(message) },
  });
  return { server, plane, sent };
}

async function listen(server: any) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port as number;
}

async function close(server: any) {
  await new Promise<void>((resolve, reject) => {
    server.close((error: unknown) => (error ? reject(error) : resolve()));
  });
}

describe("App→Edge control-plane over the real VPN socket (MP-12)", () => {
  it("доставляет creds-sync и egress по реальному TCP-сокету", async () => {
    const { server, plane, sent } = createEdgeControlListener();
    const port = await listen(server);

    try {
      const remote = createVpnTunnelTcpRemoteServer({ host: "127.0.0.1", port });
      const transport = createTunnelEdgeControlTransport({ remote });
      const client = createEdgeControlClient({ transport });

      const synced = await client.syncCredentials({
        organizationId: "org-1",
        controlId: "ctl-creds-1",
        channelId: "chan-1",
        credentials: EMAIL_CREDENTIALS,
      });
      assert.equal(synced.queued, false);
      assert.equal(plane.hasCredentials("org-1"), true);

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
      assert.deepEqual(sent[0].credentials, EMAIL_CREDENTIALS);
    } finally {
      await close(server);
    }
  });

  it("буферизует при проактивном разрыве (liveness) и дренажит по восстановлении", async () => {
    const { server, plane, sent } = createEdgeControlListener();
    const port = await listen(server);
    const link = createVpnLink();

    try {
      const remote = createVpnTunnelTcpRemoteServer({ host: "127.0.0.1", port });
      const transport = createTunnelEdgeControlTransport({ remote, link });
      const client = createEdgeControlClient({ transport });

      link.cut();
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
      assert.equal(sent.length, 0);
      assert.equal(plane.hasCredentials("org-1"), false);

      link.restore();
      const drain = await client.drain();
      assert.equal(drain.drained, 2);
      assert.equal(client.pendingCount(), 0);
      assert.equal(plane.hasCredentials("org-1"), true);
      assert.equal(sent.length, 1);
    } finally {
      await close(server);
    }
  });

  it("буферизует при реактивном разрыве (сервер недоступен) и дренажит после подъёма", async () => {
    const first = createEdgeControlListener();
    const port = await listen(first.server);
    // Роняем сервер до первой отправки — connect будет отвергнут (channel-down).
    await close(first.server);

    const remote = createVpnTunnelTcpRemoteServer({ host: "127.0.0.1", port, timeoutMs: 500 });
    const transport = createTunnelEdgeControlTransport({ remote });
    const client = createEdgeControlClient({ transport });

    const queued = await client.dispatchEgress({
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      delivery: { message_id: "msg-1", channel_type: "email", recipient_ref: "client@example.com", text: "Ответ" },
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.reason, "channel_down");
    assert.equal(client.pendingCount(), 1);

    // Поднимаем control-listener на том же порту и дренажим очередь.
    const second = createEdgeControlListener();
    await new Promise<void>((resolve, reject) => {
      second.server.once("error", reject);
      second.server.listen(port, "127.0.0.1", () => resolve());
    });
    try {
      const drain = await client.drain();
      assert.equal(drain.drained, 1);
      assert.equal(client.pendingCount(), 0);
      assert.equal(second.sent.length, 1);
    } finally {
      await close(second.server);
    }
  });
});
