import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.js";
import { createBackendChannelSecretClient } from "../../src/delivery/index.js";
import {
  createBackendChannelsClient,
  createTelegramInboundDriver,
  createTelegramUpdatesClient,
  stableTelegramMessageId,
} from "../../src/inbound/index.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const CHAN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHAN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const BACKEND = "http://backend.test";
const TELEGRAM = "https://telegram.test";
const CORE_INGRESS = "http://core.test/internal/ingress/messages";

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

describe("T3 Telegram inbound (getUpdates → SVC-INT → core ingress)", () => {
  it("routes each org's client update to core ingress with the right organization/channel", async () => {
    const world = createWorld({
      channels: [
        { channel_id: CHAN_A, organization_id: ORG_A, config: {} },
        { channel_id: CHAN_B, organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "bot-A", [ORG_B]: "bot-B" },
      updatesByToken: {
        "bot-A": [{ update_id: 10, message: message("chat-A", "client-A", "Здравствуйте, A") }],
        "bot-B": [{ update_id: 20, message: message("chat-B", "client-B", "Hello from B") }],
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
    assert.equal(a.channel_type, "telegram");
    assert.equal(a.direction, "inbound");
    assert.equal(a.conversation_ref, "chat-A"); // chat.id
    assert.equal(a.sender_ref, "client-A"); // from.id
    assert.equal(a.content.text, "Здравствуйте, A");
    assert.equal(a.message_id, stableTelegramMessageId(CHAN_A, 10));

    const b = world.messageBy(CHAN_B);
    assert.equal(b.organization_id, ORG_B);
    assert.equal(b.conversation_ref, "chat-B");
    assert.equal(b.content.text, "Hello from B");

    // Каждый бот опрошен своим токеном (изоляция каналов).
    assert.ok(world.telegramCalls.some((url) => url.includes("/botbot-A/getUpdates")));
    assert.ok(world.telegramCalls.some((url) => url.includes("/botbot-B/getUpdates")));
  });

  it("does not double a message when the same Telegram update is redelivered", async () => {
    const world = createWorld({
      channels: [{ channel_id: CHAN_A, organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "bot-A" },
      updatesByToken: {
        "bot-A": [{ update_id: 77, message: message("chat-A", "client-A", "one message") }],
      },
    });

    // Первый драйвер принимает апдейт.
    const first = world.createDriver();
    await first.refreshChannels();
    await first.pollAllOnce();
    assert.equal(world.messages.size, 1);

    // Второй драйвер (напр. после рестарта, оффсет сброшен) получает ТОТ ЖЕ апдейт
    // от Telegram заново. Стабильный message_id = tg-<channel>-<update_id> делает
    // acceptIngress идемпотентным — второго сообщения не появляется.
    const second = world.createDriver();
    await second.refreshChannels();
    await second.pollAllOnce();

    assert.equal(world.messages.size, 1, "redelivered update must not create a second message");
    assert.equal(world.ingressPosts, 2, "adapter still published twice; dedup happens at ingress");
  });
});

/**
 * Мир интеграции без сети: единый fetch маршрутизирует backend S2S (список
 * каналов + секрет), Telegram getUpdates и core ingress. «Таблица messages» —
 * in-memory map, идемпотентная по message_id (эмуляция acceptIngress).
 */
function createWorld({ channels, tokensByOrg, updatesByToken }: any) {
  const messages = new Map<string, any>();
  const telegramCalls: string[] = [];
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
      const list = channelType === "telegram" ? channels : [];
      return new Response(JSON.stringify(list), { status: 200 });
    }

    const getUpdatesMatch = url.match(/\/bot([^/]+)\/getUpdates$/);
    if (getUpdatesMatch) {
      telegramCalls.push(url);
      const token = getUpdatesMatch[1];
      const body = JSON.parse(String(init.body ?? "{}"));
      const offset = body.offset;
      const queue = updatesByToken[token] ?? [];
      const result =
        offset === undefined
          ? [...queue]
          : queue.filter((update: any) => update.update_id >= offset);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
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
  const telegramAdapter = createTelegramAdapter({ coreIngressUrl: CORE_INGRESS, fetchImpl });

  return {
    messages,
    telegramCalls,
    get ingressPosts() {
      return ingressPosts;
    },
    messageBy(channelId: string) {
      return [...messages.values()].find((m) => m.channel_id === channelId);
    },
    createDriver() {
      return createTelegramInboundDriver({
        listChannels: (input: any) => backendChannels.listChannels(input),
        resolveToken: (input: any) => secretClient.resolveToken(input),
        publishIncoming: (payload: any) => telegramAdapter.publishIncomingMessage(payload),
        createUpdatesClient: ({ token }: any) =>
          createTelegramUpdatesClient({ token, baseUrl: TELEGRAM, fetchImpl }),
        pollTimeoutSeconds: 0,
        logger: SILENT_LOGGER,
      });
    },
  };
}

function message(chatId: string, fromId: string, text: string) {
  return {
    message_id: 999,
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "Client" },
    date: 1_700_000_000,
    text,
  };
}
