import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMaxAdapter } from "../../src/adapters/max/max-adapter.js";
import { createBackendChannelSecretClient } from "../../src/delivery/index.js";
import {
  createBackendChannelsClient,
  createMaxInboundDriver,
  createMaxUpdatesClient,
  stableMaxMessageId,
} from "../../src/inbound/index.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const CHAN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHAN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const BACKEND = "http://backend.test";
const MAX_API = "https://max.test";
const CORE_INGRESS = "http://core.test/internal/ingress/messages";

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

describe("M3 MAX inbound (getUpdates → SVC-INT → core ingress)", () => {
  it("routes each org's client update to core ingress with the right organization/channel", async () => {
    const world = createWorld({
      channels: [
        { channel_id: CHAN_A, organization_id: ORG_A, config: {} },
        { channel_id: CHAN_B, organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "bot-A", [ORG_B]: "bot-B" },
      updatesByToken: {
        "bot-A": [maxUpdate("mid-A", "chat-A", "client-A", "Здравствуйте, A", 10)],
        "bot-B": [maxUpdate("mid-B", "chat-B", "client-B", "Hello from B", 20)],
      },
    });

    const driver = world.createDriver();
    await driver.refreshChannels();
    await driver.pollAllOnce();

    // Ровно два inbound-сообщения в «таблице messages», по одному на организацию.
    assert.equal(world.messages.size, 2);

    const a = world.messageBy(CHAN_A);
    assert.equal(a.organization_id, ORG_A);
    assert.equal(a.channel_id, CHAN_A);
    assert.equal(a.channel_type, "max");
    assert.equal(a.direction, "inbound");
    assert.equal(a.conversation_ref, "chat-A"); // recipient.chat_id
    assert.equal(a.sender_ref, "client-A"); // sender.user_id
    assert.equal(a.content.text, "Здравствуйте, A");
    assert.equal(a.external_message_id, "mid-A"); // body.mid
    assert.equal(a.message_id, stableMaxMessageId(CHAN_A, "mid-A"));

    const b = world.messageBy(CHAN_B);
    assert.equal(b.organization_id, ORG_B);
    assert.equal(b.conversation_ref, "chat-B");
    assert.equal(b.content.text, "Hello from B");

    // Каждый бот опрошен своим токеном (изоляция каналов).
    assert.ok(world.maxCalls.some((url) => url.includes("access_token=bot-A")));
    assert.ok(world.maxCalls.some((url) => url.includes("access_token=bot-B")));
  });

  it("does not double a message when the same MAX message is redelivered", async () => {
    const world = createWorld({
      channels: [{ channel_id: CHAN_A, organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "bot-A" },
      updatesByToken: {
        "bot-A": [maxUpdate("mid-77", "chat-A", "client-A", "one message", 77)],
      },
    });

    // Первый драйвер принимает сообщение.
    const first = world.createDriver();
    await first.refreshChannels();
    await first.pollAllOnce();
    assert.equal(world.messages.size, 1);

    // Второй драйвер (напр. после рестарта, marker сброшен) получает ТО ЖЕ сообщение
    // заново. Стабильный message_id = UUID(channel + mid) делает acceptIngress
    // идемпотентным — второго сообщения не появляется.
    const second = world.createDriver();
    await second.refreshChannels();
    await second.pollAllOnce();

    assert.equal(world.messages.size, 1, "redelivered message must not create a second record");
    assert.equal(world.ingressPosts, 2, "adapter still published twice; dedup happens at ingress");
  });
});

/**
 * Мир интеграции без сети: единый fetch маршрутизирует backend S2S (список
 * каналов + секрет), MAX getUpdates и core ingress. «Таблица messages» — in-memory
 * map, идемпотентная по message_id (эмуляция acceptIngress).
 */
function createWorld({ channels, tokensByOrg, updatesByToken }: any) {
  const messages = new Map<string, any>();
  const maxCalls: string[] = [];
  let ingressPosts = 0;

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);

    if (url.startsWith(`${BACKEND}/internal/channels/secret`)) {
      const organizationId = new URL(url).searchParams.get("organization_id") ?? "";
      const token = tokensByOrg[organizationId];
      return token
        ? new Response(JSON.stringify({ token }), { status: 200 })
        : new Response("", { status: 404 });
    }

    if (url.startsWith(`${BACKEND}/internal/channels`)) {
      const channelType = new URL(url).searchParams.get("channel_type");
      const list = channelType === "max" ? channels : [];
      return new Response(JSON.stringify(list), { status: 200 });
    }

    if (url.startsWith(`${MAX_API}/updates`)) {
      maxCalls.push(url);
      const params = new URL(url).searchParams;
      const token = params.get("access_token") ?? "";
      const markerParam = params.get("marker");
      const marker = markerParam === null ? null : Number(markerParam);
      const queue = updatesByToken[token] ?? [];
      const fresh =
        marker === null ? [...queue] : queue.filter((update: any) => update.marker > marker);
      const nextMarker = fresh.length
        ? Math.max(...fresh.map((update: any) => update.marker))
        : marker;
      return new Response(JSON.stringify({ updates: fresh, marker: nextMarker }), { status: 200 });
    }

    if (url === CORE_INGRESS) {
      ingressPosts += 1;
      const ingress = JSON.parse(String(init.body ?? "{}"));
      const message = ingress.message;
      // acceptIngress идемпотентен по message.message_id.
      if (!messages.has(message.message_id)) {
        messages.set(message.message_id, message);
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const backendChannels = createBackendChannelsClient({ baseUrl: BACKEND, fetchImpl });
  const secretClient = createBackendChannelSecretClient({
    baseUrl: BACKEND,
    now: () => 0,
    fetchImpl,
  });
  const maxAdapter = createMaxAdapter({ coreIngressUrl: CORE_INGRESS, fetchImpl });

  return {
    messages,
    maxCalls,
    get ingressPosts() {
      return ingressPosts;
    },
    messageBy(channelId: string) {
      return [...messages.values()].find((m) => m.channel_id === channelId);
    },
    createDriver() {
      return createMaxInboundDriver({
        listChannels: (input: any) => backendChannels.listChannels(input),
        resolveToken: (input: any) => secretClient.resolveToken(input),
        publishIncoming: (payload: any) => maxAdapter.publishIncomingMessage(payload),
        createUpdatesClient: ({ token }: any) =>
          createMaxUpdatesClient({ token, baseUrl: MAX_API, fetchImpl }),
        pollTimeoutSeconds: 0,
        logger: SILENT_LOGGER,
      });
    },
  };
}

function maxUpdate(mid: string, chatId: string, userId: string, text: string, marker: number) {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    marker,
    message: {
      sender: { user_id: userId, name: "Client" },
      recipient: { chat_id: chatId, chat_type: "dialog" },
      timestamp: 1_700_000_000_000,
      body: { mid, seq: 1, text },
    },
  };
}
