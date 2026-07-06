import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../../../packages/contracts/src/c9.js";
import {
  VpnTunnelAuthError,
  VpnTunnelBackpressureError,
  VpnTunnelChannelDownError,
  VpnTunnelError,
  createVpnLink,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
  resolveVpnSessionSecret,
} from "../../src/vpn-tunnel.js";

const ENDPOINT_ID = "42345678-1234-4234-8234-123456789abc";
const ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
const CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";

// Тестовые фикстуры (не реальные секреты): pre-shared секрет и сертификаты mTLS.
const SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

function canonicalMessage({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "telegram",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `секрет РФ ${seq}` },
    status: "received",
    created_at: "2026-07-04T10:10:00.000Z",
    updated_at: "2026-07-04T10:10:00.000Z",
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonicalMessage({ id, seq }),
    receivedAt: "2026-07-04T10:10:01.000Z",
  });
}

const MSG = {
  1: "12345678-1234-4234-8234-1234567890f1",
  2: "12345678-1234-4234-8234-1234567890f2",
  3: "12345678-1234-4234-8234-1234567890f3",
};

/** Собирает пару Edge↔App с общим доверием (mTLS) и секретом туннеля. */
function buildPair({
  capacity,
  handle,
  link = createVpnLink(),
}: {
  capacity?: number;
  handle?: (tunnel: any) => any;
  link?: ReturnType<typeof createVpnLink>;
} = {}) {
  const accepted = [];
  const app = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    capacity,
    link,
    handle:
      handle ??
      ((tunnel) => {
        accepted.push(tunnel);
        return { accepted: true, duplicate: false, message_id: tunnel.payload.id };
      }),
  });
  const client = createVpnTunnelEdgeClient({
    identity: { id: "edge-rf", certificate: EDGE_CERT },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
  });
  return { app, client, link, accepted };
}

describe("VPN Tunnel Service — защищённый канал Edge↔App (§7.8, CP-7)", () => {
  it("устанавливает канал по взаимной mTLS-аутентификации и доставляет C9 с ack", async () => {
    const { client, accepted } = buildPair();

    client.connect();
    assert.equal(client.isConnected(), true);

    const ack = await client.send(tunnelMessage({ id: MSG[1], seq: 1 }));
    assert.equal(ack.accepted, true);
    assert.equal(ack.message_id, MSG[1]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].payload.content.text, "секрет РФ 1");
  });

  it("шифрует в канале: кадр не содержит открытого текста, App его расшифровывает", async () => {
    const { app, client } = buildPair();
    client.connect();

    let capturedFrame;
    const realDeliver = app.deliver.bind(app);
    app.deliver = async (args) => {
      capturedFrame = args.frame;
      return realDeliver(args);
    };

    await client.send(tunnelMessage({ id: MSG[1], seq: 1 }));

    assert.ok(Buffer.isBuffer(capturedFrame), "по проводу идёт зашифрованный кадр (bytes)");
    assert.equal(capturedFrame.includes(Buffer.from("секрет РФ 1", "utf8")), false);
    assert.equal(capturedFrame.includes(Buffer.from(MSG[1], "utf8")), false);
  });

  it("обнаруживает искажение кадра в канале (GCM целостность)", async () => {
    const { app, client } = buildPair();
    client.connect();

    const realDeliver = app.deliver.bind(app);
    app.deliver = async (args) => {
      const tampered = Buffer.from(args.frame);
      tampered[tampered.length - 1] ^= 0xff;
      return realDeliver({ ...args, frame: tampered });
    };

    await assert.rejects(() => client.send(tunnelMessage({ id: MSG[1], seq: 1 })), VpnTunnelError);
  });

  it("серверная сторона mTLS отвергает недоверенный сертификат Edge", () => {
    const link = createVpnLink();
    const app = createVpnTunnelAppEndpoint({
      identity: { id: "app-core", certificate: APP_CERT },
      trustedCertificates: [EDGE_CERT],
      sessionSecret: SESSION_SECRET,
      link,
      handle: () => ({ accepted: true }),
    });
    const impostor = createVpnTunnelEdgeClient({
      identity: { id: "evil-edge", certificate: "untrusted-cert" },
      server: app,
      trustedCertificates: [APP_CERT],
      sessionSecret: SESSION_SECRET,
      link,
    });

    assert.throws(() => impostor.connect(), VpnTunnelAuthError);
    assert.equal(app.getMetrics().handshake_rejected_total, 1);
  });

  it("клиентская сторона mTLS отвергает недоверенный сертификат App", () => {
    const link = createVpnLink();
    const app = createVpnTunnelAppEndpoint({
      identity: { id: "app-core", certificate: "rogue-app-cert" },
      trustedCertificates: [EDGE_CERT],
      sessionSecret: SESSION_SECRET,
      link,
      handle: () => ({ accepted: true }),
    });
    const client = createVpnTunnelEdgeClient({
      identity: { id: "edge-rf", certificate: EDGE_CERT },
      server: app,
      trustedCertificates: [APP_CERT], // не доверяет rogue-app-cert
      sessionSecret: SESSION_SECRET,
      link,
    });

    assert.throws(() => client.connect(), VpnTunnelAuthError);
  });

  it("контроль соединения: send до connect и после disconnect — ошибка", async () => {
    const { client } = buildPair();

    await assert.rejects(() => client.send(tunnelMessage({ id: MSG[1], seq: 1 })), VpnTunnelError);

    client.connect();
    client.disconnect();
    assert.equal(client.isConnected(), false);
    await assert.rejects(() => client.send(tunnelMessage({ id: MSG[1], seq: 1 })), VpnTunnelError);
  });

  it("разрыв канала: send по разорванному каналу бросает ChannelDown и разрывает сессию", async () => {
    const { client, link } = buildPair();
    client.connect();

    link.cut();
    await assert.rejects(
      () => client.send(tunnelMessage({ id: MSG[1], seq: 1 })),
      VpnTunnelChannelDownError,
    );
    assert.equal(client.isConnected(), false);
  });

  it("авто-восстановление: ensureConnected переустанавливает туннель по backoff", async () => {
    const link = createVpnLink();
    const delays = [];
    let sleeps = 0;
    const app = createVpnTunnelAppEndpoint({
      identity: { id: "app-core", certificate: APP_CERT },
      trustedCertificates: [EDGE_CERT],
      sessionSecret: SESSION_SECRET,
      link,
      handle: () => ({ accepted: true }),
    });
    const client = createVpnTunnelEdgeClient({
      identity: { id: "edge-rf", certificate: EDGE_CERT },
      server: app,
      trustedCertificates: [APP_CERT],
      sessionSecret: SESSION_SECRET,
      link,
      backoff: [10, 20, 40],
      sleep: async (ms) => {
        delays.push(ms);
        sleeps += 1;
        // Канал восстанавливается после двух неудачных попыток.
        if (sleeps === 2) {
          link.restore();
        }
      },
    });

    client.connect();
    link.cut();
    client.disconnect();

    const result = await client.ensureConnected();

    assert.equal(result.reconnected, true);
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [10, 20]); // ждали по backoff перед восстановлением
    assert.equal(client.isConnected(), true);

    // После восстановления доставка снова работает.
    const ack = await client.send(tunnelMessage({ id: MSG[1], seq: 1 }));
    assert.equal(ack.accepted, true);
  });

  it("backpressure: пауза App заставляет send сигналить перегрузку, сессия жива", async () => {
    const { app, client } = buildPair();
    client.connect();

    app.pause();
    await assert.rejects(
      () => client.send(tunnelMessage({ id: MSG[1], seq: 1 })),
      VpnTunnelBackpressureError,
    );
    // Backpressure не рвёт сессию — Edge может буферизировать и повторить.
    assert.equal(client.isConnected(), true);
    assert.equal(client.getMetrics().backpressure_total, 1);

    app.resume();
    const ack = await client.send(tunnelMessage({ id: MSG[1], seq: 1 }));
    assert.equal(ack.accepted, true);
  });

  it("backpressure по ёмкости: при inFlight >= capacity новый send отвергается", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { client } = buildPair({
      capacity: 1,
      handle: async (tunnel) => {
        await gate;
        return { accepted: true, message_id: tunnel.payload.id };
      },
    });
    client.connect();

    const inflight = client.send(tunnelMessage({ id: MSG[1], seq: 1 })); // занимает единственный слот
    await assert.rejects(
      () => client.send(tunnelMessage({ id: MSG[2], seq: 2 })),
      VpnTunnelBackpressureError,
    );

    release();
    const ack = await inflight;
    assert.equal(ack.accepted, true);
  });

  it("resolveVpnSessionSecret падает, если секрет не сконфигурирован", () => {
    assert.throws(() => resolveVpnSessionSecret({}), VpnTunnelError);
    assert.ok(resolveVpnSessionSecret({ EDGE_VPN_SESSION_KEY: SESSION_SECRET }).length >= 16);
  });
});
