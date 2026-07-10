import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramInboundDriver } from "../../src/inbound/telegram-inbound-driver.js";
import { stableTelegramMessageId } from "../../src/inbound/ids.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

describe("Telegram inbound driver (T3)", () => {
  it("maps each bot to its organization and injects routing + stable idempotency fields", async () => {
    const harness = createHarness({
      channels: [
        { channel_id: "chan-A", organization_id: ORG_A, config: {} },
        { channel_id: "chan-B", organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "tok-A", [ORG_B]: "tok-B" },
      updatesByToken: {
        "tok-A": [{ update_id: 10, message: telegramMessage("chat-A", "user-A", "hi A") }],
        "tok-B": [{ update_id: 20, message: telegramMessage("chat-B", "user-B", "hi B") }],
      },
    });

    await harness.driver.refreshChannels();
    const published = await harness.driver.pollAllOnce();

    assert.equal(published, 2);
    assert.equal(harness.published.length, 2);

    const a = harness.published.find((p) => p.channel_id === "chan-A");
    assert.equal(a.organization_id, ORG_A);
    assert.equal(a.message_id, stableTelegramMessageId("chan-A", 10));
    assert.equal(a.idempotency_key, stableTelegramMessageId("chan-A", 10));
    assert.match(a.message_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a.message.chat.id, "chat-A");

    const b = harness.published.find((p) => p.channel_id === "chan-B");
    assert.equal(b.organization_id, ORG_B);
    assert.equal(b.message_id, stableTelegramMessageId("chan-B", 20));

    // Каждый канал резолвит токен своей организации (изоляция).
    assert.deepEqual(
      harness.resolveCalls.map((c) => c.organizationId).sort(),
      [ORG_A, ORG_B].sort(),
    );
  });

  it("advances the per-channel offset so a repeat poll does not re-deliver (dedup by update_id)", async () => {
    const harness = createHarness({
      channels: [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "tok-A" },
      updatesByToken: {
        "tok-A": [
          { update_id: 10, message: telegramMessage("chat-A", "user-A", "first") },
          { update_id: 11, message: telegramMessage("chat-A", "user-A", "second") },
        ],
      },
    });

    await harness.driver.refreshChannels();
    const firstRound = await harness.driver.pollChannelOnce("chan-A");
    const secondRound = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(firstRound, 2, "first poll ingests both updates");
    assert.equal(secondRound, 0, "second poll finds nothing new past the offset");
    assert.equal(harness.published.length, 2);
    assert.deepEqual(
      harness.published.map((p) => p.message_id),
      [stableTelegramMessageId("chan-A", 10), stableTelegramMessageId("chan-A", 11)],
    );

    // getUpdates: первый вызов без оффсета, второй — с offset = last_update_id + 1.
    assert.equal(harness.getUpdatesCalls[0].offset, undefined);
    assert.equal(harness.getUpdatesCalls[1].offset, 12);
  });

  it("keeps per-channel offsets independent across organizations", async () => {
    const harness = createHarness({
      channels: [
        { channel_id: "chan-A", organization_id: ORG_A, config: {} },
        { channel_id: "chan-B", organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "tok-A", [ORG_B]: "tok-B" },
      updatesByToken: {
        "tok-A": [{ update_id: 100, message: telegramMessage("chat-A", "user-A", "a") }],
        "tok-B": [{ update_id: 5, message: telegramMessage("chat-B", "user-B", "b") }],
      },
    });

    await harness.driver.refreshChannels();
    await harness.driver.pollAllOnce();

    const registry = Object.fromEntries(
      harness.driver.getRegistry().map((entry) => [entry.channelId, entry.offset]),
    );
    assert.equal(registry["chan-A"], 101);
    assert.equal(registry["chan-B"], 6);
  });

  it("skips updates that cannot be ingested but still advances the offset", async () => {
    const harness = createHarness({
      channels: [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "tok-A" },
      updatesByToken: {
        "tok-A": [
          { update_id: 10 }, // service update without a message → normalization fails
          { update_id: 11, message: telegramMessage("chat-A", "user-A", "real") },
        ],
      },
      // publishIncoming, отражающий telegram-адаптер: без message → бросает.
      publishIncoming: async (payload) => {
        if (!payload.message) {
          throw new TypeError("conversation_ref must be a non-empty string");
        }
      },
    });

    await harness.driver.refreshChannels();
    await harness.driver.pollChannelOnce("chan-A");

    const metrics = harness.driver.getMetrics();
    assert.equal(metrics.ingress_skipped_total, 1);
    assert.equal(metrics.ingress_published_total, 1);
    assert.equal(harness.driver.getRegistry()[0].offset, 12, "offset advances past the skipped update");
  });

  it("skips a channel with no configured token (does not call getUpdates)", async () => {
    const harness = createHarness({
      channels: [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }],
      tokensByOrg: {},
      updatesByToken: {},
    });

    await harness.driver.refreshChannels();
    const published = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(published, 0);
    assert.equal(harness.getUpdatesCalls.length, 0, "no token → no getUpdates call");
    assert.equal(harness.driver.getMetrics().missing_token_total, 1);
  });

  it("drops channels that disappear from the backend registry on refresh", async () => {
    let channels = [
      { channel_id: "chan-A", organization_id: ORG_A, config: {} },
      { channel_id: "chan-B", organization_id: ORG_B, config: {} },
    ];
    const harness = createHarness({
      channels: () => channels,
      tokensByOrg: { [ORG_A]: "tok-A", [ORG_B]: "tok-B" },
      updatesByToken: {},
    });

    await harness.driver.refreshChannels();
    assert.equal(harness.driver.getRegistry().length, 2);

    channels = [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }];
    await harness.driver.refreshChannels();
    assert.deepEqual(
      harness.driver.getRegistry().map((entry) => entry.channelId),
      ["chan-A"],
    );
  });
});

function createHarness({ channels, tokensByOrg, updatesByToken, publishIncoming }: any) {
  const published: any[] = [];
  const getUpdatesCalls: Array<{ token: string; offset: number | undefined }> = [];
  const resolveCalls: Array<{ organizationId?: string }> = [];

  const driver = createTelegramInboundDriver({
    listChannels: async () => (typeof channels === "function" ? channels() : channels),
    resolveToken: async ({ organizationId }: any) => {
      resolveCalls.push({ organizationId });
      return tokensByOrg[organizationId] ?? null;
    },
    publishIncoming:
      publishIncoming ??
      (async (payload: any) => {
        published.push(payload);
        return { accepted: true };
      }),
    createUpdatesClient: ({ token }: any) => ({
      async getUpdates({ offset }: any) {
        getUpdatesCalls.push({ token, offset });
        const queue = updatesByToken[token] ?? [];
        return offset === undefined
          ? [...queue]
          : queue.filter((update: any) => update.update_id >= offset);
      },
    }),
    pollTimeoutSeconds: 0,
    logger: SILENT_LOGGER,
  });

  return { driver, published, getUpdatesCalls, resolveCalls };
}

function telegramMessage(chatId: string, fromId: string, text: string) {
  return {
    message_id: 555,
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "Client" },
    date: 1_700_000_000,
    text,
  };
}
