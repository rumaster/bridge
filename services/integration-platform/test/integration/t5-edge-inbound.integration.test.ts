import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.js";
import { createBackendChannelSecretClient } from "../../src/delivery/index.js";
import {
  createBackendChannelsClient,
  createIngressPublisher,
  createTelegramInboundDriver,
  createTelegramUpdatesClient,
  stableTelegramMessageId,
} from "../../src/inbound/index.js";

const ORG_RF = "11111111-1111-1111-1111-111111111111";
const ORG_INT = "22222222-2222-2222-2222-222222222222";
const CHAN_RF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHAN_INT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const BACKEND = "http://backend.test";
const TELEGRAM = "https://telegram.test";
const CORE_INGRESS = "http://core.test/internal/ingress/messages";
const EDGE_INGRESS = "http://edge.test/internal/edge/ingress/messages";

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

describe("T5 Telegram inbound via Edge (RF-first) + degradation", () => {
  it("routes an RF client's update through the Edge and a non-RF client's straight to core", async () => {
    const world = createWorld({
      channels: [
        { channel_id: CHAN_RF, organization_id: ORG_RF, config: { region: "RF" } },
        { channel_id: CHAN_INT, organization_id: ORG_INT, config: {} },
      ],
      tokensByOrg: { [ORG_RF]: "bot-RF", [ORG_INT]: "bot-INT" },
      updatesByToken: {
        "bot-RF": [{ update_id: 10, message: message("chat-RF", "client-RF", "Привет из РФ") }],
        "bot-INT": [{ update_id: 20, message: message("chat-INT", "client-INT", "Hi from abroad") }],
      },
    });

    const driver = world.createDriver();
    await driver.refreshChannels();
    await driver.pollAllOnce();

    // RF-клиент приземлился в Edge (RF-first), не напрямую в ядро.
    assert.equal(world.edge.size, 1);
    assert.equal(world.core.size, 1);

    const rf = world.edgeBy(CHAN_RF);
    assert.equal(rf.contract, "C2.IngressMessage");
    assert.equal(rf.message.organization_id, ORG_RF);
    assert.equal(rf.message.conversation_ref, "chat-RF");
    assert.equal(rf.id, stableTelegramMessageId(CHAN_RF, 10));
    assert.ok(world.edgeUrls.every((u) => u === EDGE_INGRESS));

    const intl = world.coreBy(CHAN_INT);
    assert.equal(intl.message.organization_id, ORG_INT);
    assert.equal(intl.message.conversation_ref, "chat-INT");
  });

  it("does not lose an RF update while the Edge is down; redelivers it on recovery", async () => {
    const world = createWorld({
      channels: [{ channel_id: CHAN_RF, organization_id: ORG_RF, config: { region: "RF" } }],
      tokensByOrg: { [ORG_RF]: "bot-RF" },
      updatesByToken: {
        "bot-RF": [{ update_id: 42, message: message("chat-RF", "client-RF", "нужно дойти") }],
      },
    });

    // Edge недоступен (напр. edge-gateway лежит) — публикация падает retryable.
    world.edgeStatus = 503;
    const driver = world.createDriver();
    await driver.refreshChannels();
    await driver.pollChannelOnce(CHAN_RF);

    assert.equal(world.edge.size, 0, "nothing landed while edge is down");
    assert.equal(driver.getMetrics().publish_retry_total, 1);
    // Оффсет НЕ продвинут — апдейт будет переопрошен.
    assert.equal(driver.getRegistry()[0].offset, undefined);

    // Edge восстановился — тот же апдейт переопрашивается и доходит (не потерян).
    world.edgeStatus = 202;
    await driver.pollChannelOnce(CHAN_RF);

    assert.equal(world.edge.size, 1, "message delivered after recovery");
    assert.equal(world.edgeBy(CHAN_RF).id, stableTelegramMessageId(CHAN_RF, 42));
    assert.equal(driver.getRegistry()[0].offset, 43, "offset advances only after success");
  });
});

function createWorld({ channels, tokensByOrg, updatesByToken }: any) {
  const world: any = {
    edge: new Map<string, any>(),
    core: new Map<string, any>(),
    edgeUrls: [] as string[],
    edgeStatus: 202,
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

    const getUpdatesMatch = url.match(/\/bot([^/]+)\/getUpdates$/);
    if (getUpdatesMatch) {
      const token = getUpdatesMatch[1];
      const offset = JSON.parse(String(init.body ?? "{}")).offset;
      const queue = updatesByToken[token] ?? [];
      const result =
        offset === undefined ? [...queue] : queue.filter((u: any) => u.update_id >= offset);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }

    if (url === EDGE_INGRESS) {
      world.edgeUrls.push(url);
      if (world.edgeStatus >= 400) {
        return new Response("edge down", { status: world.edgeStatus });
      }
      const body = JSON.parse(String(init.body ?? "{}"));
      if (!world.edge.has(body.id)) {
        world.edge.set(body.id, body); // RF-first buffer (idempotent by id)
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    if (url === CORE_INGRESS) {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (!world.core.has(body.message.message_id)) {
        world.core.set(body.message.message_id, body);
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const backendChannels = createBackendChannelsClient({ baseUrl: BACKEND, fetchImpl });
  const secretClient = createBackendChannelSecretClient({ baseUrl: BACKEND, now: () => 0, fetchImpl });
  const telegramAdapter = createTelegramAdapter({ coreIngressUrl: CORE_INGRESS, fetchImpl });
  const publisher = createIngressPublisher({
    coreIngressUrl: CORE_INGRESS,
    edgeIngressUrl: EDGE_INGRESS,
    fetchImpl,
  });

  world.edgeBy = (channelId: string) =>
    [...world.edge.values()].find((m) => m.message.channel_id === channelId);
  world.coreBy = (channelId: string) =>
    [...world.core.values()].find((m) => m.message.channel_id === channelId);

  world.createDriver = () =>
    createTelegramInboundDriver({
      listChannels: (input: any) => backendChannels.listChannels(input),
      resolveToken: (input: any) => secretClient.resolveToken(input),
      publishIncoming: (payload: any, channel: any) => {
        const ingress = telegramAdapter.buildIngress(payload);
        const routeViaEdge =
          publisher.edgeAvailable() && (channel?.config?.region === "RF" || channel?.config?.route_via_edge === true);
        return publisher.publish(ingress, { routeViaEdge });
      },
      createUpdatesClient: ({ token }: any) =>
        createTelegramUpdatesClient({ token, baseUrl: TELEGRAM, fetchImpl }),
      pollTimeoutSeconds: 0,
      logger: SILENT_LOGGER,
    });

  return world;
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
