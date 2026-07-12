import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMaxInboundDriver } from "../../src/inbound/max-inbound-driver.js";
import { stableMaxMessageId } from "../../src/inbound/ids.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

describe("MAX inbound driver (M3)", () => {
  it("maps each bot to its organization and injects routing + stable idempotency fields", async () => {
    const harness = createHarness({
      channels: [
        { channel_id: "chan-A", organization_id: ORG_A, config: {} },
        { channel_id: "chan-B", organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "tok-A", [ORG_B]: "tok-B" },
      updatesByToken: {
        "tok-A": [maxUpdate("mid-A", "chat-A", "user-A", "hi A", 10)],
        "tok-B": [maxUpdate("mid-B", "chat-B", "user-B", "hi B", 20)],
      },
    });

    await harness.driver.refreshChannels();
    const published = await harness.driver.pollAllOnce();

    assert.equal(published, 2);
    assert.equal(harness.published.length, 2);

    const a = harness.published.find((p) => p.channel_id === "chan-A");
    assert.equal(a.organization_id, ORG_A);
    assert.equal(a.message_id, stableMaxMessageId("chan-A", "mid-A"));
    assert.equal(a.idempotency_key, stableMaxMessageId("chan-A", "mid-A"));
    assert.match(a.message_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a.message.recipient.chat_id, "chat-A");
    assert.equal(a.message.sender.user_id, "user-A");

    const b = harness.published.find((p) => p.channel_id === "chan-B");
    assert.equal(b.organization_id, ORG_B);
    assert.equal(b.message_id, stableMaxMessageId("chan-B", "mid-B"));

    // Каждый канал резолвит токен своей организации (изоляция).
    assert.deepEqual(
      harness.resolveCalls.map((c) => c.organizationId).sort(),
      [ORG_A, ORG_B].sort(),
    );
  });

  it("advances the per-channel marker so a repeat poll does not re-deliver (dedup by mid)", async () => {
    const harness = createHarness({
      channels: [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "tok-A" },
      updatesByToken: {
        "tok-A": [
          maxUpdate("mid-1", "chat-A", "user-A", "first", 10),
          maxUpdate("mid-2", "chat-A", "user-A", "second", 11),
        ],
      },
    });

    await harness.driver.refreshChannels();
    const firstRound = await harness.driver.pollChannelOnce("chan-A");
    const secondRound = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(firstRound, 2, "first poll ingests both updates");
    assert.equal(secondRound, 0, "second poll finds nothing new past the marker");
    assert.equal(harness.published.length, 2);
    assert.deepEqual(
      harness.published.map((p) => p.message_id),
      [stableMaxMessageId("chan-A", "mid-1"), stableMaxMessageId("chan-A", "mid-2")],
    );

    // getUpdates: первый вызов без marker, второй — с marker = last batch marker.
    assert.equal(harness.getUpdatesCalls[0].marker, undefined);
    assert.equal(harness.getUpdatesCalls[1].marker, 11);
  });

  it("keeps per-channel markers independent across organizations", async () => {
    const harness = createHarness({
      channels: [
        { channel_id: "chan-A", organization_id: ORG_A, config: {} },
        { channel_id: "chan-B", organization_id: ORG_B, config: {} },
      ],
      tokensByOrg: { [ORG_A]: "tok-A", [ORG_B]: "tok-B" },
      updatesByToken: {
        "tok-A": [maxUpdate("mid-a", "chat-A", "user-A", "a", 100)],
        "tok-B": [maxUpdate("mid-b", "chat-B", "user-B", "b", 5)],
      },
    });

    await harness.driver.refreshChannels();
    await harness.driver.pollAllOnce();

    const registry = Object.fromEntries(
      harness.driver.getRegistry().map((entry) => [entry.channelId, entry.marker]),
    );
    assert.equal(registry["chan-A"], 100);
    assert.equal(registry["chan-B"], 5);
  });

  it("skips updates that cannot be ingested but still advances the marker", async () => {
    const harness = createHarness({
      channels: [{ channel_id: "chan-A", organization_id: ORG_A, config: {} }],
      tokensByOrg: { [ORG_A]: "tok-A" },
      updatesByToken: {
        "tok-A": [
          { update_type: "bot_started", marker: 10 }, // service update, no message
          maxUpdate("mid-2", "chat-A", "user-A", "real", 11),
        ],
      },
      // publishIncoming, отражающий MAX-адаптер: без message → бросает.
      publishIncoming: async (payload: any) => {
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
    assert.equal(harness.driver.getRegistry()[0].marker, 11, "marker advances past the skipped update");
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
  const getUpdatesCalls: Array<{ token: string; marker: number | undefined | null }> = [];
  const resolveCalls: Array<{ organizationId?: string }> = [];

  const driver = createMaxInboundDriver({
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
      async getUpdates({ marker }: any) {
        getUpdatesCalls.push({ token, marker });
        const queue = updatesByToken[token] ?? [];
        const fresh =
          marker === undefined || marker === null
            ? [...queue]
            : queue.filter((update: any) => update.marker > marker);
        const nextMarker = fresh.length
          ? Math.max(...fresh.map((update: any) => update.marker))
          : (marker ?? null);
        return { updates: fresh, marker: nextMarker };
      },
    }),
    pollTimeoutSeconds: 0,
    logger: SILENT_LOGGER,
  });

  return { driver, published, getUpdatesCalls, resolveCalls };
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
