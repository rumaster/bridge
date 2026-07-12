import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeControlMessage } from "../../../../packages/contracts/src/c9.js";
import { createEdgeChannelRuntime } from "../../src/edge-channel-drivers.js";
import { createEdgeCluster } from "../../src/edge-cluster.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { VpnTunnelChannelDownError } from "../../src/vpn-tunnel.js";

/**
 * Интеграция сборки edge-owned MAX-рантайма (Этап M5): реестр каналов выводится
 * из синхронизированных кред control-plane, входящее идёт RF-first через кластер,
 * ответ — через MAX-sender; деградация (обрыв туннеля → буфер → дренаж).
 */

const RF_KEY = Buffer.alloc(32, 7).toString("base64");
const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");
const ORG = "org-1";
const CHANNEL = "chan-1";
const MAX_BASE = "https://max.test";

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

function maxUpdate(mid: string, text: string, marker: number) {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    marker,
    message: {
      sender: { user_id: "client-1" },
      recipient: { chat_id: "chat-1" },
      body: { mid, text },
    },
  };
}

function buildStack() {
  const dataTunnel = createFakeDataTunnel();
  const cluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel: dataTunnel });

  const updatesQueue: any[] = [];
  const maxSent: any[] = [];
  const fetchImpl = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.startsWith(`${MAX_BASE}/updates`)) {
      const markerParam = new URL(u).searchParams.get("marker");
      const marker = markerParam === null ? null : Number(markerParam);
      const fresh =
        marker === null ? [...updatesQueue] : updatesQueue.filter((x) => x.marker > marker);
      const next = fresh.length ? Math.max(...fresh.map((x) => x.marker)) : marker;
      return new Response(JSON.stringify({ updates: fresh, marker: next }), { status: 200 });
    }
    if (u.startsWith(`${MAX_BASE}/messages`)) {
      maxSent.push({ url: u, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ message: { body: { mid: "out-1" } } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const runtime = createEdgeChannelRuntime({
    cluster,
    cipher: createRfPayloadCipher({ key: CACHE_KEY }),
    env: { MAX_API_BASE_URL: MAX_BASE },
    fetchImpl,
    logger: { warn() {}, error() {}, info() {} },
  });

  return { dataTunnel, cluster, runtime, updatesQueue, maxSent };
}

function syncMaxToken(runtime: any, controlId: string, token = "tok-A") {
  return runtime.controlPlane.handle(
    createEdgeControlMessage({
      type: "channel_credentials_sync",
      organizationId: ORG,
      controlId,
      issuedAt: "2026-07-12T10:00:00.000Z",
      payload: { channel_id: CHANNEL, channel_type: "max", credentials: { token } },
    }),
  );
}

describe("edge channel runtime assembly (M5)", () => {
  it("discovers the channel from synced creds and lands inbound RF-first through the tunnel", async () => {
    const { dataTunnel, runtime, updatesQueue } = buildStack();

    // Нет кред → реестр пуст, поллинг пропускает.
    await runtime.maxDriver.refreshChannels();
    updatesQueue.push(maxUpdate("mid-1", "где заказ?", 10));
    assert.equal(await runtime.maxDriver.pollAllOnce(), 0, "no creds → channel not discovered");
    assert.equal(dataTunnel.sent.length, 0);

    // Синхронизируем токен → канал появляется в реестре из creds.
    await syncMaxToken(runtime, "ctl-creds-1");
    await runtime.maxDriver.refreshChannels();
    const ingested = await runtime.maxDriver.pollAllOnce();

    assert.equal(ingested, 1);
    assert.equal(dataTunnel.sent.length, 1);
    const inbound = dataTunnel.sent[0].payload.message;
    assert.equal(inbound.channel_type, "max");
    assert.equal(inbound.organization_id, ORG);
    assert.equal(inbound.channel_id, CHANNEL);
    assert.equal(inbound.conversation_ref, "chat-1");
    assert.equal(inbound.content.text, "где заказ?");
  });

  it("buffers RF-first when the tunnel is down and drains after reconnect (no loss)", async () => {
    const { dataTunnel, cluster, runtime, updatesQueue } = buildStack();
    await syncMaxToken(runtime, "ctl-creds-1");
    await runtime.maxDriver.refreshChannels();

    dataTunnel.cut();
    updatesQueue.push(maxUpdate("mid-1", "вопрос при обрыве", 10));
    const ingested = await runtime.maxDriver.pollAllOnce();

    assert.equal(ingested, 1, "ingest to RF buffer succeeds even while tunnel is down");
    assert.equal(dataTunnel.sent.length, 0, "not forwarded while down (buffered RF-first)");
    assert.equal(await cluster.pendingCount(), 1);

    dataTunnel.restore();
    await cluster.drain();
    assert.equal(dataTunnel.sent.length, 1, "buffered inbound forwarded after reconnect");
  });

  it("routes a manager reply through the MAX sender (egress_dispatch → MAX Bot API)", async () => {
    const { runtime, maxSent } = buildStack();
    await syncMaxToken(runtime, "ctl-creds-1", "tok-A");

    const ack = await runtime.controlPlane.handle(
      createEdgeControlMessage({
        type: "egress_dispatch",
        organizationId: ORG,
        controlId: "ctl-egress-1",
        issuedAt: "2026-07-12T10:00:01.000Z",
        payload: {
          message_id: "reply-1",
          channel_id: CHANNEL,
          channel_type: "max",
          recipient_ref: "chat-1",
          text: "Заказ отправлен",
        },
      }),
    );

    assert.equal(ack.status, "sent");
    assert.equal(maxSent.length, 1);
    assert.equal(maxSent[0].url, `${MAX_BASE}/messages?access_token=tok-A&chat_id=chat-1`);
    assert.deepEqual(maxSent[0].body, { text: "Заказ отправлен" });
  });
});
