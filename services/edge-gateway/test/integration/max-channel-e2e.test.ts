import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeCluster } from "../../src/edge-cluster.js";
import { createEdgeControlClient } from "../../src/edge-control-client.js";
import { createEdgeControlPlane } from "../../src/edge-control-plane.js";
import { createInProcessEdgeControlTransport } from "../../src/edge-control-tunnel.js";
import { createEdgeMaxInboundDriver } from "../../src/edge-max-inbound-driver.js";
import { createEdgeMaxSender } from "../../src/edge-max-sender.js";
import { createRfPayloadCipher } from "../../src/rf-payload-cipher.js";
import { VpnTunnelChannelDownError } from "../../src/vpn-tunnel.js";

/**
 * Сквозная приёмка MAX-канала на Edge (Этап M4 плана max-channel-production).
 *
 * Собирает edge-компоненты MAX в детерминированном in-process контуре (реальные
 * сетевые сокеты — веха MP-12) и прогоняет DoD: синхронизация токена → приём
 * апдейта (getUpdates → RF-first → туннель) → ответ менеджера (egress_dispatch →
 * MAX Bot API) → отсутствие потерь при разрыве в обе стороны → идемпотентность.
 */

const RF_KEY = Buffer.alloc(32, 7).toString("base64");
const CACHE_KEY = Buffer.alloc(32, 5).toString("base64");
const SESSION_KEY = Buffer.alloc(32, 9);
const ORG = "org-1";
const CHANNEL = "chan-1";
const CLIENT_CHAT = "chat-1";
const MAX_TOKEN = "max-bot-token-org-1";

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

function createFakeUpdatesClient(initial: any[] = []) {
  const queue = [...initial];
  return {
    push(...updates: any[]) {
      queue.push(...updates);
    },
    async getUpdates({ marker }: { marker?: number | null }) {
      const fresh =
        marker === undefined || marker === null
          ? [...queue]
          : queue.filter((update) => (update.marker ?? 0) > marker);
      const nextMarker = fresh.length
        ? Math.max(...fresh.map((update) => update.marker ?? 0))
        : (marker ?? null);
      return { updates: fresh, marker: nextMarker };
    },
  };
}

function maxUpdate(mid: string, text: string, marker: number) {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    marker,
    message: {
      sender: { user_id: "client-user-1" },
      recipient: { chat_id: CLIENT_CHAT },
      body: { mid, text },
    },
  };
}

function buildEdgeMaxStack() {
  // Data-plane (Edge→App): RF-first буфер + туннель.
  const dataTunnel = createFakeDataTunnel();
  const edgeCluster = createEdgeCluster({ cipher: createRfPayloadCipher({ key: RF_KEY }), tunnel: dataTunnel });

  // Исходящий MAX Bot API (M4) с fake-fetch.
  const maxSent: any[] = [];
  const sender = createEdgeMaxSender({
    baseUrl: "https://max.test",
    fetchImpl: async (url: any, init: any) => {
      maxSent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ message: { body: { mid: `out-${maxSent.length}` } } }), {
        status: 200,
      });
    },
  });

  // Control-plane (App→Edge): кэш кред + диспетчеризация egress с maxSender.
  const plane = createEdgeControlPlane({
    cipher: createRfPayloadCipher({ key: CACHE_KEY }),
    maxSender: sender,
  });
  const controlTransport = createInProcessEdgeControlTransport({
    sessionId: "app-core:edge:session",
    sessionKey: SESSION_KEY,
    controlPlane: plane,
  });
  const controlClient = createEdgeControlClient({ transport: controlTransport });

  // Входящий MAX-драйвер (M4): токен берёт из control-plane кэша.
  const updatesClient = createFakeUpdatesClient();
  const driver = createEdgeMaxInboundDriver({
    listChannels: async () => [{ channelId: CHANNEL, organizationId: ORG }],
    resolveCredentials: () => plane.getChannelCredentials(ORG, "max"),
    createUpdatesClient: () => updatesClient,
    ingest: (body) => edgeCluster.ingest(body),
    logger: { warn() {}, error() {}, info() {} },
  });

  return { dataTunnel, edgeCluster, maxSent, sender, plane, controlTransport, controlClient, updatesClient, driver };
}

describe("MAX channel end-to-end on Edge (M4 acceptance)", () => {
  it("runs the full scenario: token sync → inbound → reply → no-loss on break → idempotency", async () => {
    const stack = buildEdgeMaxStack();
    const { dataTunnel, edgeCluster, maxSent, plane, controlTransport, controlClient, updatesClient, driver } = stack;
    await driver.refreshChannels();

    // 1. Backend синхронизирует токен MAX на Edge (M4, канал-осведомлённый creds-sync).
    const synced = await controlClient.syncCredentials({
      organizationId: ORG,
      controlId: "ctl-creds-1",
      channelId: CHANNEL,
      channelType: "max",
      credentials: { token: MAX_TOKEN },
    });
    assert.equal(synced.queued, false);
    assert.equal(plane.hasCredentials(ORG, "max"), true);

    // 2. Входящее: апдейт клиента забирается getUpdates, RF-first, через туннель.
    updatesClient.push(maxUpdate("mid-1", "где заказ?", 10));
    await driver.pollChannelOnce(CHANNEL);

    assert.equal(dataTunnel.sent.length, 1);
    const inbound = dataTunnel.sent[0].payload.message;
    assert.equal(inbound.channel_type, "max");
    assert.equal(inbound.content.text, "где заказ?");
    assert.equal(inbound.conversation_ref, CLIENT_CHAT);
    assert.equal(inbound.external_message_id, "mid-1");

    // 3. Менеджер отвечает: egress_dispatch → MAX Bot API sendMessage.
    const dispatched = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-1",
      delivery: {
        message_id: "reply-1",
        channel_id: CHANNEL,
        channel_type: "max",
        recipient_ref: CLIENT_CHAT,
        text: "Заказ отправлен",
      },
    });
    assert.equal((dispatched.ack as any).status, "sent");
    assert.equal(maxSent.length, 1);
    assert.equal(maxSent[0].url, `https://max.test/messages?access_token=${MAX_TOKEN}&chat_id=${CLIENT_CHAT}`);
    assert.deepEqual(maxSent[0].body, { text: "Заказ отправлен" });

    // 4a. Разрыв туннеля на входящем: апдейт RF-first буферизуется, дренажится позже.
    dataTunnel.cut();
    updatesClient.push(maxUpdate("mid-2", "ещё вопрос", 11));
    await driver.pollChannelOnce(CHANNEL);
    assert.equal(dataTunnel.sent.length, 1, "buffered RF-first, not forwarded while down");
    assert.equal(await edgeCluster.pendingCount(), 1);
    dataTunnel.restore();
    await edgeCluster.drain();
    assert.equal(dataTunnel.sent.length, 2, "buffered inbound forwarded after reconnect");

    // 4b. Разрыв control-канала на исходящем: egress встаёт в очередь, дренажится позже.
    controlTransport.link.cut();
    const queued = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-2",
      delivery: {
        message_id: "reply-2",
        channel_id: CHANNEL,
        channel_type: "max",
        recipient_ref: CLIENT_CHAT,
        text: "второй ответ",
      },
    });
    assert.equal(queued.queued, true);
    assert.equal(maxSent.length, 1, "not sent while control channel down");
    controlTransport.link.restore();
    const drain = await controlClient.drain();
    assert.equal(drain.drained, 1);
    assert.equal(maxSent.length, 2, "queued reply sent after reconnect");

    // 5. Идемпотентность: повтор egress по тому же control_id не шлёт дважды.
    const dupe = await controlClient.dispatchEgress({
      organizationId: ORG,
      controlId: "ctl-egress-1",
      delivery: {
        message_id: "reply-1",
        channel_id: CHANNEL,
        channel_type: "max",
        recipient_ref: CLIENT_CHAT,
        text: "Заказ отправлен",
      },
    });
    assert.equal((dupe.ack as any).duplicate, true);
    assert.equal(maxSent.length, 2, "duplicate control_id must not re-send");
  });

  it("gates inbound on credential sync (no token → channel skipped)", async () => {
    const stack = buildEdgeMaxStack();
    await stack.driver.refreshChannels();

    stack.updatesClient.push(maxUpdate("mid-x", "hi", 1));
    const ingested = await stack.driver.pollChannelOnce(CHANNEL);

    assert.equal(ingested, 0);
    assert.equal(stack.dataTunnel.sent.length, 0);
    assert.equal(stack.driver.getMetrics().missing_credentials_total, 1);
  });
});
