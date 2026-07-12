import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeMaxInboundDriver } from "../../src/edge-max-inbound-driver.js";
import { stableMaxMessageId } from "../../src/edge-ids.js";

const ORG_A = "org-a";
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function maxUpdate(mid: string, chatId: string, userId: string, text: string, marker: number) {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    marker,
    message: {
      sender: { user_id: userId },
      recipient: { chat_id: chatId },
      body: { mid, text },
    },
  };
}

describe("edge MAX inbound driver (M4)", () => {
  it("ingests updates RF-first, maps org/channel, and normalizes to C2", async () => {
    const harness = createHarness({
      channels: [{ channelId: "chan-A", organizationId: ORG_A }],
      credsByOrg: { [ORG_A]: { token: "tok-A" } },
      updatesByToken: { "tok-A": [maxUpdate("mid-1", "chat-A", "user-A", "hi", 10)] },
    });

    await harness.driver.refreshChannels();
    const ingested = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(ingested, 1);
    assert.equal(harness.ingested.length, 1);
    const body = harness.ingested[0];
    assert.equal(body.message.channel_type, "max");
    assert.equal(body.message.organization_id, ORG_A);
    assert.equal(body.message.channel_id, "chan-A");
    assert.equal(body.message.conversation_ref, "chat-A");
    assert.equal(body.message.sender_ref, "user-A");
    assert.equal(body.message.content.text, "hi");
    assert.equal(body.message.message_id, stableMaxMessageId("chan-A", "mid-1"));
    // Поля верхнего уровня для RF-буфера.
    assert.equal(body.id, stableMaxMessageId("chan-A", "mid-1"));
    assert.ok(body.endpoint_id);
  });

  it("advances the marker so a repeat poll does not re-ingest", async () => {
    const harness = createHarness({
      channels: [{ channelId: "chan-A", organizationId: ORG_A }],
      credsByOrg: { [ORG_A]: { token: "tok-A" } },
      updatesByToken: {
        "tok-A": [
          maxUpdate("mid-1", "chat-A", "user-A", "first", 10),
          maxUpdate("mid-2", "chat-A", "user-A", "second", 11),
        ],
      },
    });

    await harness.driver.refreshChannels();
    const first = await harness.driver.pollChannelOnce("chan-A");
    const second = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(first, 2);
    assert.equal(second, 0, "advanced marker → nothing new");
    assert.equal(harness.ingested.length, 2);
    assert.equal(harness.getUpdatesCalls[0].marker, undefined);
    assert.equal(harness.getUpdatesCalls[1].marker, 11);
  });

  it("skips a channel without synced credentials (does not call getUpdates)", async () => {
    const harness = createHarness({
      channels: [{ channelId: "chan-A", organizationId: ORG_A }],
      credsByOrg: {},
      updatesByToken: {},
    });

    await harness.driver.refreshChannels();
    const ingested = await harness.driver.pollChannelOnce("chan-A");

    assert.equal(ingested, 0);
    assert.equal(harness.getUpdatesCalls.length, 0);
    assert.equal(harness.driver.getMetrics().missing_credentials_total, 1);
  });

  it("skips a non-ingestible update but still advances the marker", async () => {
    const harness = createHarness({
      channels: [{ channelId: "chan-A", organizationId: ORG_A }],
      credsByOrg: { [ORG_A]: { token: "tok-A" } },
      updatesByToken: {
        "tok-A": [
          { update_type: "bot_started", marker: 10 }, // service update → non-ingestible
          maxUpdate("mid-2", "chat-A", "user-A", "real", 11),
        ],
      },
    });

    await harness.driver.refreshChannels();
    await harness.driver.pollChannelOnce("chan-A");

    const metrics = harness.driver.getMetrics();
    assert.equal(metrics.skipped_total, 1);
    assert.equal(metrics.ingested_total, 1);
    assert.equal(harness.driver.getRegistry()[0].marker, 11);
  });

  it("does not lose an update when ingest fails (marker not advanced, redelivered on retry)", async () => {
    let failNext = true;
    const ingestedBodies: any[] = [];
    const harness = createHarness({
      channels: [{ channelId: "chan-A", organizationId: ORG_A }],
      credsByOrg: { [ORG_A]: { token: "tok-A" } },
      updatesByToken: { "tok-A": [maxUpdate("mid-1", "chat-A", "user-A", "hi", 10)] },
      ingest: async (body: any) => {
        if (failNext) {
          failNext = false;
          throw new Error("RF buffer backpressure");
        }
        ingestedBodies.push(body);
      },
    });

    await harness.driver.refreshChannels();
    const firstTry = await harness.driver.pollChannelOnce("chan-A");
    assert.equal(firstTry, 0, "ingest failed → nothing counted");
    assert.equal(harness.driver.getRegistry()[0].marker, undefined, "marker not advanced on failure");
    assert.equal(harness.driver.getMetrics().ingest_retry_total, 1);

    const retry = await harness.driver.pollChannelOnce("chan-A");
    assert.equal(retry, 1, "same update redelivered and ingested on retry");
    assert.equal(ingestedBodies.length, 1);
  });
});

function createHarness({ channels, credsByOrg, updatesByToken, ingest }: any) {
  const ingested: any[] = [];
  const getUpdatesCalls: Array<{ token: string; marker: number | undefined | null }> = [];

  const driver = createEdgeMaxInboundDriver({
    listChannels: async () => channels,
    resolveCredentials: async ({ organizationId }: any) => credsByOrg[organizationId] ?? null,
    createUpdatesClient: ({ credentials }: any) => ({
      async getUpdates({ marker }: any) {
        const token = credentials.token;
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
    ingest:
      ingest ??
      (async (body: any) => {
        ingested.push(body);
      }),
    pollIntervalMs: 0,
    logger: SILENT_LOGGER,
  });

  return { driver, ingested, getUpdatesCalls };
}
