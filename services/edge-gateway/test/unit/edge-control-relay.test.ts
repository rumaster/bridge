import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createEdgeControlClient } from "../../src/edge-control-client.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createEdgeControlRelayServer } from "../../src/edge-control-relay.js";
import { createTunnelEdgeControlTransport } from "../../src/edge-control-transport.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { createVpnLink } from "../../src/vpn-tunnel.js";
import {
  createVpnTunnelTcpAppServer,
  createVpnTunnelTcpRemoteServer,
} from "../../src/vpn-transport.js";

const CACHE_KEY = Buffer.alloc(32, 7).toString("base64");

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

function credsSyncMessage(controlId: string) {
  return {
    contract: "C9.EdgeControlMessage",
    version: "1.0.0",
    control_id: controlId,
    type: "channel_credentials_sync",
    organization_id: "org-1",
    issued_at: "2026-07-13T10:00:00.000Z",
    payload: { channel_id: "chan-1", channel_type: "email", credentials: EMAIL_CREDENTIALS },
  };
}

function egressMessage(controlId: string, messageId: string) {
  return {
    contract: "C9.EdgeControlMessage",
    version: "1.0.0",
    control_id: controlId,
    type: "egress_dispatch",
    organization_id: "org-1",
    issued_at: "2026-07-13T10:00:00.000Z",
    payload: {
      message_id: messageId,
      channel_id: "chan-1",
      channel_type: "email",
      recipient_ref: "client@example.com",
      subject: "Re: заявка",
      text: "Ответ",
    },
  };
}

function channelTestMessage(controlId: string) {
  return {
    contract: "C9.EdgeControlMessage",
    version: "1.0.0",
    control_id: controlId,
    type: "channel_test",
    organization_id: "org-1",
    issued_at: "2026-07-13T10:00:00.000Z",
    payload: { channel_id: "chan-1", channel_type: "email", credentials: EMAIL_CREDENTIALS },
  };
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

/** Полный контур: Edge control-listener + App relay поверх реального TCP. */
async function buildContour({ testerOk = true }: { testerOk?: boolean } = {}) {
  const sent: any[] = [];
  const plane = createEdgeControlPlane({
    cipher: createRfPayloadCipher({ key: CACHE_KEY }),
    emailSender: {
      async send(delivery) {
        sent.push(delivery);
        return { external_message_id: `smtp-${sent.length}` };
      },
    },
    channelTester: {
      async test() {
        const ok = testerOk;
        return {
          ok,
          imap: { ok, ...(ok ? {} : { detail: "IMAP LOGIN failed" }) },
          smtp: { ok, ...(ok ? {} : { detail: "SMTP verify failed" }) },
          ...(ok ? {} : { detail: "IMAP LOGIN failed" }),
        };
      },
    },
  });
  const edgeListener = createVpnTunnelTcpAppServer({
    endpoint: { control: (message) => plane.handle(message) },
  });
  const edgePort = await listen(edgeListener);

  const link = createVpnLink();
  const remote = createVpnTunnelTcpRemoteServer({ host: "127.0.0.1", port: edgePort, timeoutMs: 500 });
  const transport = createTunnelEdgeControlTransport({ remote, link });
  const client = createEdgeControlClient({ transport });
  const relay = createEdgeControlRelayServer({
    dispatch: (message) => client.dispatch(message),
    sendNow: (message) => transport.send(message),
  });
  const relayPort = await listen(relay);
  const relayUrl = `http://127.0.0.1:${relayPort}/internal/edge/control/relay`;

  return { plane, sent, link, client, edgeListener, edgePort, relay, relayUrl };
}

async function postRelay(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, ack: (await response.json()) as any };
}

describe("edge control relay (backend → edge-vpn-app → tunnel → Edge)", () => {
  it("проталкивает creds-sync и egress по туннелю и возвращает Edge-ack", async () => {
    const c = await buildContour();
    try {
      const creds = await postRelay(c.relayUrl, credsSyncMessage("creds-1"));
      assert.equal(creds.status, 202);
      assert.equal(creds.ack.status, "stored");
      assert.equal(c.plane.hasCredentials("org-1"), true);

      const egress = await postRelay(c.relayUrl, egressMessage("egress-1", "msg-1"));
      assert.equal(egress.ack.status, "sent");
      assert.equal(c.sent.length, 1);
      assert.deepEqual(c.sent[0].credentials, EMAIL_CREDENTIALS);
    } finally {
      await close(c.relay);
      await close(c.edgeListener);
    }
  });

  it("channel_test выполняется синхронно (без очереди) и возвращает connected", async () => {
    const c = await buildContour({ testerOk: true });
    try {
      const probe = await postRelay(c.relayUrl, channelTestMessage("test-1"));
      assert.equal(probe.ack.status, "connected");
      assert.equal(c.client.pendingCount(), 0);
    } finally {
      await close(c.relay);
      await close(c.edgeListener);
    }
  });

  it("channel_test при разорванном туннеле → error (НЕ ставится в очередь)", async () => {
    const c = await buildContour();
    try {
      c.link.cut();
      const probe = await postRelay(c.relayUrl, channelTestMessage("test-1"));
      assert.equal(probe.ack.status, "error");
      assert.equal(c.client.pendingCount(), 0);
    } finally {
      await close(c.relay);
      await close(c.edgeListener);
    }
  });

  it("creds-sync/egress при разрыве → queued, дренаж после восстановления доставляет", async () => {
    const c = await buildContour();
    try {
      c.link.cut();
      const creds = await postRelay(c.relayUrl, credsSyncMessage("creds-1"));
      const egress = await postRelay(c.relayUrl, egressMessage("egress-1", "msg-1"));
      assert.equal(creds.ack.status, "queued");
      assert.equal(creds.ack.queued, true);
      assert.equal(egress.ack.status, "queued");
      assert.equal(c.client.pendingCount(), 2);
      assert.equal(c.sent.length, 0);

      c.link.restore();
      const drain = await c.client.drain();
      assert.equal(drain.drained, 2);
      assert.equal(c.plane.hasCredentials("org-1"), true);
      assert.equal(c.sent.length, 1);
    } finally {
      await close(c.relay);
      await close(c.edgeListener);
    }
  });

  it("повторный egress тем же control_id не шлёт письмо дважды (идемпотентность)", async () => {
    const c = await buildContour();
    try {
      const first = await postRelay(c.relayUrl, egressMessage("egress-1", "msg-1"));
      assert.equal(first.ack.status, "sent");
      const second = await postRelay(c.relayUrl, egressMessage("egress-1", "msg-1"));
      assert.equal(second.ack.duplicate, true);
      assert.equal(c.sent.length, 1);
    } finally {
      await close(c.relay);
      await close(c.edgeListener);
    }
  });
});
