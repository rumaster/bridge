import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockBackendApi } from "../../src/backend-client.mjs";
import { createSyncEngine } from "../../src/sync-engine.mjs";
import { MobileSyncCursorError, createSyncCursor, parseSyncCursor } from "../../src/sync-cursor.mjs";

const CONTEXT = { organizationId: "org-1", userId: "manager-1", deviceId: "device-mobile-1" };

let clock = 0;
const now = () => `2026-07-04T12:00:00.${String(clock++).padStart(3, "0")}Z`;

function harness() {
  clock = 0;
  const backend = createMockBackendApi({ now });
  backend.seedClient({ organizationId: "org-1", clientId: "client-1", displayName: "Ada" });
  backend.seedConversation({
    organizationId: "org-1",
    conversationId: "conversation-1",
    clientId: "client-1",
    displayName: "Ada",
  });
  const engine = createSyncEngine({ backend, context: CONTEXT, now });
  return { backend, engine };
}

function sendMessage(backend, messageId, text) {
  return backend.sendMessage({
    organizationId: "org-1",
    conversationId: "conversation-1",
    messageId,
    idempotencyKey: messageId,
    senderType: "manager",
    text,
  });
}

describe("SVC-MOB sync-engine (offline→online, §19.3)", () => {
  it("returns every change on a first (cursorless) sync and a watermark", () => {
    const { backend, engine } = harness();
    sendMessage(backend, "message-1", "one");
    backend.createNotification({
      organizationId: "org-1",
      notificationId: "notification-1",
      recipientUserId: "manager-1",
      title: "Ping",
    });

    const response = engine.sync({});
    assert.equal(response.previous_cursor, null);
    assert.equal(response.deltas.messages.length, 1);
    assert.equal(response.deltas.notifications.length, 1);
    assert.equal(response.deltas.dialogs.length, 1);

    const watermark = response.deltas.statuses.find((s) => s.kind === "sync.watermark");
    assert.ok(watermark, "delta stream carries a sync watermark");
    assert.equal(parseSyncCursor(response.cursor).value.sequence, watermark.sequence);
  });

  it("advances the cursor monotonically and never replays applied deltas", () => {
    const { backend, engine } = harness();
    sendMessage(backend, "message-1", "one");

    const first = engine.sync({});
    const firstSeq = parseSyncCursor(first.cursor).value.sequence;
    assert.equal(first.deltas.messages.map((m) => m.message_id).includes("message-1"), true);

    // Новое сообщение уже после первого курсора.
    sendMessage(backend, "message-2", "two");
    const second = engine.sync({ cursor: first.cursor });
    const secondSeq = parseSyncCursor(second.cursor).value.sequence;

    assert.ok(secondSeq > firstSeq, "cursor moves strictly forward");
    // Никаких дублей: message-1 применён, повторно не приходит; приходит только message-2.
    assert.deepEqual(
      second.deltas.messages.map((m) => m.message_id),
      ["message-2"],
    );
  });

  it("is a stable read: re-syncing the same cursor yields the same slice (no loss)", () => {
    const { backend, engine } = harness();
    sendMessage(backend, "message-1", "one");
    const first = engine.sync({});
    sendMessage(backend, "message-2", "two");

    const replayA = engine.sync({ cursor: first.cursor });
    const replayB = engine.sync({ cursor: first.cursor });
    assert.deepEqual(
      replayA.deltas.messages.map((m) => m.message_id),
      replayB.deltas.messages.map((m) => m.message_id),
    );
  });

  it("returns an empty delta and a steady cursor once fully caught up", () => {
    const { backend, engine } = harness();
    sendMessage(backend, "message-1", "one");
    const first = engine.sync({});
    const caughtUp = engine.sync({ cursor: first.cursor });

    assert.equal(caughtUp.deltas.messages.length, 0);
    assert.equal(caughtUp.deltas.notifications.length, 0);
    // Курсор не откатывается: sequence остаётся тем же.
    assert.equal(
      parseSyncCursor(caughtUp.cursor).value.sequence,
      parseSyncCursor(first.cursor).value.sequence,
    );
  });

  it("rejects a cursor issued for a different organization (tenant isolation)", () => {
    const { engine } = harness();
    const foreign = createSyncCursor({
      organizationId: "org-999",
      userId: "manager-1",
      deviceId: "device-mobile-1",
      sequence: 0,
      issuedAt: "2026-07-04T11:00:00.000Z",
    });
    assert.throws(() => engine.sync({ cursor: foreign }), MobileSyncCursorError);
  });

  it("rejects a cursor issued for a different user (tenant isolation)", () => {
    const { engine } = harness();
    const foreign = createSyncCursor({
      organizationId: "org-1",
      userId: "intruder",
      deviceId: "device-mobile-1",
      sequence: 0,
      issuedAt: "2026-07-04T11:00:00.000Z",
    });
    assert.throws(() => engine.sync({ cursor: foreign }), MobileSyncCursorError);
  });

  it("honours the page limit and reports has_more", () => {
    const { backend, engine } = harness();
    sendMessage(backend, "message-1", "one");
    sendMessage(backend, "message-2", "two");
    sendMessage(backend, "message-3", "three");

    const page = engine.sync({ limit: 2 });
    assert.equal(page.has_more, true);
    assert.equal(page.limit, 2);
  });
});
