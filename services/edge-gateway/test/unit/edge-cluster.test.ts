import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeCluster, EdgeClusterError } from "../../src/edge-cluster.js";
import { createInMemoryEdgeMessageBufferStore } from "../../src/edge-message-buffer.js";
import { createEdgeSequencer } from "../../src/edge-sequencer.js";
import { createRfPayloadCipher, RF_PAYLOAD_KEY_BYTES } from "../../src/rf-payload-cipher.js";
import {
  VpnTunnelChannelDownError,
  createVpnLink,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
} from "../../src/vpn-tunnel.js";

const ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
const CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";
const ENDPOINT_A = "42345678-1234-4234-8234-1234567890a1";
const ENDPOINT_B = "42345678-1234-4234-8234-1234567890b2";

// Тестовые фикстуры (не реальные секреты): pre-shared секрет туннеля и сертификаты mTLS.
const SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 9);
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

// Детерминированные монотонные ISO-таймстемпы (received_at строго возрастает).
const EPOCH = Date.parse("2026-07-04T10:00:00.000Z");
let clock = 0;
function now() {
  clock += 1;
  return new Date(EPOCH + clock * 1000).toISOString();
}

const IDS = {
  1: "12345678-1234-4234-8234-1234567890c1",
  2: "12345678-1234-4234-8234-1234567890c2",
  3: "12345678-1234-4234-8234-1234567890c3",
  4: "12345678-1234-4234-8234-1234567890c4",
};

/** Входящее RF-сообщение (канонический C1 без sequence_number — присваивается на Edge). */
function inbound({ id, endpoint = ENDPOINT_A, text = "секрет РФ" }) {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: endpoint,
    channel: "telegram",
    direction: "inbound",
    sender_type: "client",
    type: "text",
    content: { text },
    status: "received",
    created_at: "2026-07-04T10:00:00.000Z",
    updated_at: "2026-07-04T10:00:00.000Z",
  };
}

/** Fake-ядро на App-стороне туннеля: принимает C9 и дедуплицирует по idempotency_key. */
function createFakeCore() {
  const accepted = [];
  const seen = new Set();
  return {
    accepted,
    handle(tunnelMessage) {
      const key = tunnelMessage.idempotency_key;
      if (seen.has(key)) {
        return { accepted: true, duplicate: true, message_id: tunnelMessage.payload.id };
      }
      seen.add(key);
      accepted.push(tunnelMessage.payload);
      return { accepted: true, duplicate: false, message_id: tunnelMessage.payload.id };
    },
  };
}

/** Собирает Edge Cluster поверх реального VPN-туннеля к fake-ядру (RF-first конвейер). */
function buildCluster({ capacity }: { capacity?: number } = {}) {
  const link = createVpnLink();
  const core = createFakeCore();
  const app = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    capacity,
    link,
    handle: (tunnelMessage) => core.handle(tunnelMessage),
  });
  const tunnel = createVpnTunnelEdgeClient({
    identity: { id: "edge-rf", certificate: EDGE_CERT },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    sleep: async () => {},
  });
  const bufferStore = createInMemoryEdgeMessageBufferStore();
  const cipher = createRfPayloadCipher({ key: CIPHER_KEY });
  const cluster = createEdgeCluster({
    cipher,
    tunnel,
    sequencer: createEdgeSequencer(),
    bufferStore,
    now,
  });
  return { cluster, tunnel, app, link, core, bufferStore, cipher };
}

describe("Edge Cluster РФ — RF-first конвейер (§7.3/§7.9/§7.10/§7.14, CP-7)", () => {
  it("на входе присваивает sequence_number, фиксирует шифртекст в RF и пересылает через туннель", async () => {
    const { cluster, tunnel, core, bufferStore, cipher } = buildCluster();
    tunnel.connect();

    const result = await cluster.ingest(inbound({ id: IDS[1] }));

    // §7.10 — sequence_number присвоен на входе Edge.
    assert.equal(result.sequence_number, 1);
    assert.equal(result.idempotency_key, IDS[1]);
    assert.equal(result.duplicate, false);
    assert.equal(result.fixed_in_rf, true);
    assert.equal(result.forwarded, true);
    assert.equal(result.ack.accepted, true);

    // Ядро получило payload с присвоенными sequence_number/idempotency_key.
    assert.equal(core.accepted.length, 1);
    assert.equal(core.accepted[0].id, IDS[1]);
    assert.equal(core.accepted[0].sequence_number, 1);
    assert.equal(core.accepted[0].idempotency_key, IDS[1]);

    // §7.14 — первичная фиксация в RF-буфере сохраняется, запись помечена forwarded.
    const stored = await bufferStore.get(IDS[1]);
    assert.ok(stored, "запись первичной фиксации остаётся в RF-контуре");
    assert.ok(stored.forwarded_at, "успешная пересылка помечена forwarded_at");
    assert.equal(await cluster.pendingCount(), 0);

    // §7.9 — в буфере только шифртекст (ПДн не хранятся в открытом виде).
    assert.ok(Buffer.isBuffer(stored.payload_encrypted));
    assert.equal(stored.payload_encrypted.includes(Buffer.from("секрет РФ", "utf8")), false);
    assert.equal(stored.payload_encrypted.includes(Buffer.from(IDS[1], "utf8")), false);
    const aad = { endpoint_id: ENDPOINT_A, sequence_number: 1, idempotency_key: IDS[1] };
    assert.equal(cipher.decrypt(stored.payload_encrypted, { aad }).content.text, "секрет РФ");

    const metrics = cluster.getMetrics();
    assert.equal(metrics.ingested_total, 1);
    assert.equal(metrics.fixed_in_rf_total, 1);
    assert.equal(metrics.forwarded_total, 1);
    assert.equal(metrics.buffered_offline_total, 0);
  });

  it("присваивает монотонный sequence_number на каждый endpoint отдельно (ключ партиционирования)", async () => {
    const { cluster, tunnel } = buildCluster();
    tunnel.connect();

    const a1 = await cluster.ingest(inbound({ id: IDS[1], endpoint: ENDPOINT_A }));
    const b1 = await cluster.ingest(inbound({ id: IDS[2], endpoint: ENDPOINT_B }));
    const a2 = await cluster.ingest(inbound({ id: IDS[3], endpoint: ENDPOINT_A }));
    const b2 = await cluster.ingest(inbound({ id: IDS[4], endpoint: ENDPOINT_B }));

    assert.deepEqual(
      [a1.sequence_number, a2.sequence_number],
      [1, 2],
      "endpoint A нумеруется независимо",
    );
    assert.deepEqual(
      [b1.sequence_number, b2.sequence_number],
      [1, 2],
      "endpoint B нумеруется независимо",
    );
  });

  it("дедуплицирует повтор idempotency_key на входе Edge — без повторной пересылки", async () => {
    const { cluster, tunnel, core } = buildCluster();
    tunnel.connect();

    const first = await cluster.ingest(inbound({ id: IDS[1] }));
    const repeat = await cluster.ingest(inbound({ id: IDS[1], text: "повтор" }));

    assert.equal(first.duplicate, false);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.fixed_in_rf, false, "повтор не фиксируется заново");
    assert.equal(repeat.forwarded, false, "повтор не пересылается повторно");
    assert.equal(repeat.sequence_number, 1, "возвращается sequence_number исходной фиксации");

    // Ядро увидело сообщение ровно один раз.
    assert.equal(core.accepted.length, 1);
    assert.equal(core.accepted[0].content.text, "секрет РФ");

    const metrics = cluster.getMetrics();
    assert.equal(metrics.ingested_total, 2);
    assert.equal(metrics.duplicate_total, 1);
    assert.equal(metrics.fixed_in_rf_total, 1);
    assert.equal(metrics.forwarded_total, 1);
  });

  it("буферизирует при разрыве канала и дренажирует в порядке после восстановления (§7.9, без потерь/дублей)", async () => {
    const { cluster, tunnel, link, core, bufferStore, cipher } = buildCluster();
    tunnel.connect();

    // Разрыв VPN Tunnel до приёма трёх сообщений.
    link.cut();
    const r1 = await cluster.ingest(inbound({ id: IDS[1] }));
    const r2 = await cluster.ingest(inbound({ id: IDS[2] }));
    const r3 = await cluster.ingest(inbound({ id: IDS[3] }));

    // Каждое зафиксировано в RF, но не переслано (RF-first даже офлайн).
    for (const r of [r1, r2, r3]) {
      assert.equal(r.fixed_in_rf, true);
      assert.equal(r.forwarded, false);
    }
    assert.deepEqual([r1.sequence_number, r2.sequence_number, r3.sequence_number], [1, 2, 3]);
    assert.equal(core.accepted.length, 0, "офлайн — ничего не ушло за рубеж");
    assert.equal(await cluster.pendingCount(), 3);

    // §7.14 — офлайн-запись в RF-буфере несёт восстановимый шифртекст ПДн.
    const buffered = await bufferStore.get(IDS[2]);
    const aad = { endpoint_id: ENDPOINT_A, sequence_number: 2, idempotency_key: IDS[2] };
    assert.equal(cipher.decrypt(buffered.payload_encrypted, { aad }).id, IDS[2]);

    // Восстановление канала → авто-дренаж.
    link.restore();
    const drainResult = await cluster.drain();

    assert.equal(drainResult.drained, 3);
    assert.deepEqual(
      drainResult.forwarded.map((f) => f.sequence_number),
      [1, 2, 3],
      "дренаж соблюдает порядок (endpoint_id, sequence_number)",
    );
    assert.deepEqual(
      core.accepted.map((m) => m.id),
      [IDS[1], IDS[2], IDS[3]],
      "ядро получило все три сообщения в порядке, без потерь",
    );
    assert.equal(await cluster.pendingCount(), 0);

    // Повторный дренаж идемпотентен — без дублей.
    const secondDrain = await cluster.drain();
    assert.equal(secondDrain.drained, 0);
    assert.equal(core.accepted.length, 3);

    const metrics = cluster.getMetrics();
    assert.equal(metrics.buffered_offline_total, 3);
    assert.equal(metrics.drained_total, 3);
  });

  it("сигнал backpressure удерживает сообщение в буфере, дренаж проходит после resume", async () => {
    const { cluster, tunnel, app, core } = buildCluster();
    tunnel.connect();

    app.pause(); // App-сторона перегружена.
    const result = await cluster.ingest(inbound({ id: IDS[1] }));

    assert.equal(result.fixed_in_rf, true);
    assert.equal(result.forwarded, false);
    assert.equal(result.reason, "backpressure");
    assert.equal(core.accepted.length, 0);
    assert.equal(await cluster.pendingCount(), 1);
    assert.equal(cluster.getMetrics().backpressure_total, 1);

    app.resume();
    const drainResult = await cluster.drain();
    assert.equal(drainResult.drained, 1);
    assert.equal(core.accepted.length, 1);
    assert.equal(await cluster.pendingCount(), 0);
  });

  it("разрыв канала (ChannelDown) при пересылке удерживает запись в буфере", async () => {
    // Стаб-туннель: считается подключённым, но send рвётся ChannelDown.
    const tunnel = {
      isConnected: () => true,
      async send() {
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down");
      },
    };
    const cluster = createEdgeCluster({
      cipher: createRfPayloadCipher({ key: CIPHER_KEY }),
      tunnel,
      bufferStore: createInMemoryEdgeMessageBufferStore(),
      now,
    });

    const result = await cluster.ingest(inbound({ id: IDS[1] }));
    assert.equal(result.fixed_in_rf, true);
    assert.equal(result.forwarded, false);
    assert.equal(result.reason, "channel_down");
    assert.equal(await cluster.pendingCount(), 1);
    assert.equal(cluster.getMetrics().channel_down_total, 1);
  });

  it("дренаж запускает авто-восстановление туннеля (ensureConnected) и пересылает накопленное", async () => {
    const { cluster, tunnel, link, core } = buildCluster();
    tunnel.connect();

    // Полный разрыв: канал вниз и сессия сброшена.
    link.cut();
    tunnel.disconnect();
    await cluster.ingest(inbound({ id: IDS[1] }));
    await cluster.ingest(inbound({ id: IDS[2] }));
    assert.equal(await cluster.pendingCount(), 2);
    assert.equal(tunnel.isConnected(), false);

    // Канал восстановился — дренаж сам переустанавливает туннель.
    link.restore();
    const drainResult = await cluster.drain();

    assert.equal(tunnel.isConnected(), true);
    assert.equal(tunnel.getMetrics().reconnect_total, 1);
    assert.equal(drainResult.drained, 2);
    assert.deepEqual(
      core.accepted.map((m) => m.id),
      [IDS[1], IDS[2]],
    );
  });

  it("валидирует конфигурацию и обязательные поля входящего сообщения", async () => {
    assert.throws(() => createEdgeCluster({ tunnel: { send() {} } }), EdgeClusterError);
    assert.throws(
      () => createEdgeCluster({ cipher: createRfPayloadCipher({ key: CIPHER_KEY }) }),
      EdgeClusterError,
    );

    const { cluster, tunnel } = buildCluster();
    tunnel.connect();
    await assert.rejects(() => cluster.ingest({ id: IDS[1] }), EdgeClusterError); // нет endpoint_id
    await assert.rejects(
      () => cluster.ingest({ endpoint_id: ENDPOINT_A }),
      EdgeClusterError,
    ); // нет id
  });
});
