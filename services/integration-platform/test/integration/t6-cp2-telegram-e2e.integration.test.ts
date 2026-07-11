import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.js";
import {
  createAdapterDeliveryChannel,
  createBackendChannelSecretClient,
  createBackendDeliveryClient,
  createBackoffPolicy,
  createDeliveryEngine,
  createResolvingTelegramClient,
} from "../../src/delivery/index.js";
import {
  createBackendChannelsClient,
  createIngressPublisher,
  createTelegramInboundDriver,
  createTelegramUpdatesClient,
  stableTelegramMessageId,
} from "../../src/inbound/index.js";

/**
 * CP-2 «Telegram: приём и ответ» — сквозная приёмка на границе SVC-INT↔CORE
 * (Этап T6, docs/plan/telegram-channel-production.md).
 *
 * Реальные компоненты SVC-INT (входящий драйвер T3/T5 + движок доставки T2)
 * прогоняются против замоканных Telegram Bot API и backend-ядра (без сети/Docker,
 * стиль t2/t3/t5). Проверяется: сквозной путь клиент→менеджер→клиент,
 * мультитенантность (два бота/две организации), идемпотентность в обе стороны и
 * деградация Telegram API. Полный e2e с реальным Postgres (routed→sent→delivered в
 * БД) — CI-профиль Testcontainers (internal-messaging.spec).
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAN_A = "11111111-1111-4111-8111-111111111111";
const CHAN_B = "22222222-2222-4222-8222-222222222222";

const BACKEND = "http://backend.test";
const TELEGRAM = "https://telegram.test";
const CORE_INGRESS = "http://backend.test/internal/ingress/messages";

const SILENT = { info() {}, warn() {}, error() {} };

describe("T6 CP-2 Telegram end-to-end (client ↔ manager ↔ client)", () => {
  it("round-trips both directions and isolates two organizations", async () => {
    const world = createWorld({
      updatesByToken: {
        "bot-A": [{ update_id: 10, message: tgMessage("chat-A", "client-A", "Заказ где?") }],
        "bot-B": [{ update_id: 20, message: tgMessage("chat-B", "client-B", "Where is my order?") }],
      },
    });

    // 1) Входящее: клиенты пишут ботам своих организаций → приходит в ядро.
    await world.driver.refreshChannels();
    await world.driver.pollAllOnce();

    assert.equal(world.messages.size, 2);
    const inA = world.messageBy(CHAN_A);
    assert.equal(inA.organization_id, ORG_A);
    assert.equal(inA.conversation_ref, "chat-A");
    assert.equal(inA.sender_ref, "client-A");
    assert.equal(inA.content.text, "Заказ где?");
    assert.equal(world.messageBy(CHAN_B).organization_id, ORG_B);

    // 2) Исходящее: менеджер отвечает клиенту в его же чат, токеном ЭТОЙ организации.
    const replyA = await world.engine.deliver(reply(ORG_A, "chat-A", "Ваш заказ в пути"));
    const replyB = await world.engine.deliver(reply(ORG_B, "chat-B", "Your order shipped"));

    assert.equal(replyA.delivered, true);
    assert.equal(replyA.status, "delivered");
    assert.equal(replyB.delivered, true);

    // Изоляция: org A → bot-A/chat-A, org B → bot-B/chat-B.
    assert.equal(world.sends.length, 2);
    const sendA = world.sends.find((s) => s.token === "bot-A");
    const sendB = world.sends.find((s) => s.token === "bot-B");
    assert.equal(sendA.chatId, "chat-A");
    assert.equal(sendA.text, "Ваш заказ в пути");
    assert.equal(sendB.chatId, "chat-B");

    // Обратная нога: попытка доставки зафиксирована в ядре как delivered.
    const attemptA = world.attempts.find((a) => a.organization_id === ORG_A);
    assert.equal(attemptA.status, "delivered");
    assert.equal(attemptA.adapter, "telegram");
  });

  it("is idempotent: a redelivered update and a repeated egress never double", async () => {
    const world = createWorld({
      updatesByToken: {
        "bot-A": [{ update_id: 77, message: tgMessage("chat-A", "client-A", "один раз") }],
      },
    });

    // Входящее — дважды (второй драйвер = рестарт, оффсет сброшен): тот же UUID.
    await world.driver.refreshChannels();
    await world.driver.pollAllOnce();
    const secondDriver = world.newDriver();
    await secondDriver.refreshChannels();
    await secondDriver.pollAllOnce();
    assert.equal(world.messages.size, 1, "redelivered update does not create a 2nd message");

    // Исходящее — дважды с тем же idempotency_key: один реальный sendMessage.
    const first = await world.engine.deliver(reply(ORG_A, "chat-A", "готово"));
    const dup = await world.engine.deliver(reply(ORG_A, "chat-A", "готово"));
    assert.equal(first.delivered, true);
    assert.equal(dup.duplicate, true);
    assert.equal(world.sends.length, 1, "repeated egress must not re-send");
  });

  it("degrades safely: a Telegram API failure on egress is recorded failed without blocking core", async () => {
    const world = createWorld({ updatesByToken: {}, sendStatusByToken: { "bot-A": 500 } });

    const result = await world.engine.deliver(reply(ORG_A, "chat-A", "не дойдёт"));

    assert.equal(result.delivered, false);
    assert.equal(result.status, "failed");
    // Ядро уведомлено о провале (обратная нога), доставка не бросила исключение.
    assert.ok(world.attempts.some((a) => a.status === "failed" && a.organization_id === ORG_A));
  });
});

function createWorld({ updatesByToken = {}, sendStatusByToken = {} }: any) {
  const tokensByOrg: Record<string, string> = { [ORG_A]: "bot-A", [ORG_B]: "bot-B" };
  const channels = [
    { channel_id: CHAN_A, organization_id: ORG_A, config: {} },
    { channel_id: CHAN_B, organization_id: ORG_B, config: {} },
  ];

  const world: any = {
    messages: new Map<string, any>(),
    sends: [] as Array<{ token: string; chatId: unknown; text: unknown }>,
    attempts: [] as any[],
  };

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
      return new Response(JSON.stringify(channelType === "telegram" ? channels : []), { status: 200 });
    }

    if (url === CORE_INGRESS) {
      const ingress = JSON.parse(String(init.body ?? "{}"));
      const message = ingress.message;
      if (!world.messages.has(message.message_id)) {
        world.messages.set(message.message_id, message); // acceptIngress idempotent by message.id
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    if (url === `${BACKEND}/internal/delivery/attempts`) {
      world.attempts.push(JSON.parse(String(init.body ?? "{}")));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    const getUpdates = url.match(/\/bot([^/]+)\/getUpdates$/);
    if (getUpdates) {
      const token = getUpdates[1];
      const offset = JSON.parse(String(init.body ?? "{}")).offset;
      const queue = updatesByToken[token] ?? [];
      const result = offset === undefined ? [...queue] : queue.filter((u: any) => u.update_id >= offset);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }

    const sendMessage = url.match(/\/bot([^/]+)\/sendMessage$/);
    if (sendMessage) {
      const token = sendMessage[1];
      const body = JSON.parse(String(init.body ?? "{}"));
      world.sends.push({ token, chatId: body.chat_id, text: body.text });
      const status = sendStatusByToken[token] ?? 200;
      return status >= 400
        ? new Response(JSON.stringify({ ok: false, description: "telegram down" }), { status })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const secretClient = createBackendChannelSecretClient({ baseUrl: BACKEND, now: () => 0, fetchImpl });
  const backendChannels = createBackendChannelsClient({ baseUrl: BACKEND, fetchImpl });
  const inboundAdapter = createTelegramAdapter({ coreIngressUrl: CORE_INGRESS, fetchImpl });
  const ingressPublisher = createIngressPublisher({ coreIngressUrl: CORE_INGRESS, fetchImpl });

  world.newDriver = () =>
    createTelegramInboundDriver({
      listChannels: (i: any) => backendChannels.listChannels(i),
      resolveToken: (i: any) => secretClient.resolveToken(i),
      publishIncoming: (payload: any) => ingressPublisher.publish(inboundAdapter.buildIngress(payload)),
      createUpdatesClient: ({ token }: any) => createTelegramUpdatesClient({ token, baseUrl: TELEGRAM, fetchImpl }),
      pollTimeoutSeconds: 0,
      logger: SILENT,
    });
  world.driver = world.newDriver();

  // Egress: per-org токен + движок доставки. Без mock-fallback (T6 задача 5):
  // telegram доставляется только реальным адаптером.
  const telegramDeliveryClient = createResolvingTelegramClient({
    baseUrl: TELEGRAM,
    resolveToken: (i: any) => secretClient.resolveToken(i),
    fetchImpl,
  });
  const deliveryChannel = createAdapterDeliveryChannel({
    adapters: { telegram: createTelegramAdapter({ channelClient: telegramDeliveryClient, coreIngressUrl: CORE_INGRESS }) },
  });
  world.engine = createDeliveryEngine({
    channel: deliveryChannel,
    backendClient: createBackendDeliveryClient({ baseUrl: BACKEND, fetchImpl }),
    backoff: createBackoffPolicy({ baseDelayMs: 1, factor: 1, maxAttempts: 2 }),
    sleep: async () => {},
  });

  world.messageBy = (channelId: string) =>
    [...world.messages.values()].find((m) => m.channel_id === channelId);

  return world;
}

function reply(organizationId: string, conversationRef: string, text: string) {
  const messageId = stableTelegramMessageId(conversationRef, `reply-${text}`);
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: "chan-1",
    message: {
      message_id: messageId,
      organization_id: organizationId,
      channel_id: "chan-1",
      channel_type: "telegram",
      direction: "outbound",
      conversation_ref: conversationRef,
      content: { type: "text", text },
    },
  };
}

function tgMessage(chatId: string, fromId: string, text: string) {
  return {
    message_id: 900,
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "Client" },
    date: 1_700_000_000,
    text,
  };
}
