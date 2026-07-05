import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockBackendApi } from "../../src/backend-client.js";

let clock = 0;
const now = () => `2026-07-04T12:00:00.${String(clock++).padStart(3, "0")}Z`;

function freshBackend() {
  clock = 0;
  const backend = createMockBackendApi({ now });
  backend.seedClient({ organizationId: "org-1", clientId: "client-1", displayName: "Ada" });
  backend.seedConversation({
    organizationId: "org-1",
    conversationId: "conversation-1",
    clientId: "client-1",
    displayName: "Ada",
  });
  return backend;
}

describe("SVC-MOB mock-Backend (C3.*/C10 change feed)", () => {
  it("assigns a monotonic per-conversation sequence to sent messages", () => {
    const backend = freshBackend();
    const first = backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      idempotencyKey: "message-1",
      senderType: "manager",
      text: "one",
    });
    const second = backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-2",
      idempotencyKey: "message-2",
      senderType: "manager",
      text: "two",
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.message.sequence_number, 1);
    assert.equal(first.message.status, "sent");
    assert.equal(second.message.sequence_number, 2);
  });

  it("deduplicates a repeated send by idempotency_key (§11.12)", () => {
    const backend = freshBackend();
    const first = backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      idempotencyKey: "message-1",
      senderType: "manager",
      text: "hello",
    });
    const repeat = backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      idempotencyKey: "message-1",
      senderType: "manager",
      text: "hello",
    });

    assert.equal(first.duplicate, false);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.message.sequence_number, first.message.sequence_number);
    assert.equal(backend.getMetrics().messages_deduplicated_total, 1);
    // Дубль не порождает второй записи в ленте изменений.
    assert.equal(backend.currentSequence("org-1"), 1);
  });

  it("rejects a send whose idempotency_key is not the message_id (§11.12)", () => {
    const backend = freshBackend();
    assert.throws(
      () =>
        backend.sendMessage({
          organizationId: "org-1",
          conversationId: "conversation-1",
          messageId: "message-1",
          idempotencyKey: "other-key",
          senderType: "manager",
          text: "x",
        }),
      TypeError,
    );
  });

  it("rejects an unsupported sender_type", () => {
    const backend = freshBackend();
    assert.throws(
      () =>
        backend.sendMessage({
          organizationId: "org-1",
          conversationId: "conversation-1",
          messageId: "message-1",
          idempotencyKey: "message-1",
          senderType: "robot",
          text: "x",
        }),
      TypeError,
    );
  });

  it("restores order and drops duplicates when draining an Edge batch (CP-7)", () => {
    const backend = freshBackend();
    const batch = [
      { id: "rf-2", organization_id: "org-1", conversation_id: "conversation-1", sequence_number: 2, text: "second" },
      { id: "rf-1", organization_id: "org-1", conversation_id: "conversation-1", sequence_number: 1, text: "first" },
    ];

    const result = backend.ingestEdgeBatch(batch);
    assert.deepEqual(result, { ingested: 2, duplicates: 0, ordered: true });

    // Лента изменений восстановлена по sequence_number (rf-1 перед rf-2).
    const { changes } = backend.getChangesSince({ organizationId: "org-1", sinceSequence: 0 });
    assert.deepEqual(
      changes.map((change) => change.entity.id),
      ["rf-1", "rf-2"],
    );

    // Повторный дренаж той же пачки — только дубли, без новых записей.
    const replay = backend.ingestEdgeBatch(batch);
    assert.deepEqual(replay, { ingested: 0, duplicates: 2, ordered: true });
    assert.equal(backend.currentSequence("org-1"), 2);
  });

  it("returns null when applying a status change to an unknown message", () => {
    const backend = freshBackend();
    assert.equal(
      backend.applyStatusChange({ organizationId: "org-1", messageId: "ghost", status: "read" }),
      null,
    );
  });

  it("appends a status change and reflects it in the message", () => {
    const backend = freshBackend();
    backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      idempotencyKey: "message-1",
      senderType: "manager",
      text: "hi",
    });
    const updated = backend.applyStatusChange({
      organizationId: "org-1",
      messageId: "message-1",
      status: "read",
    });
    assert.equal(updated.status, "read");
    const { changes } = backend.getChangesSince({ organizationId: "org-1", sinceSequence: 1 });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "status");
    assert.equal(changes[0].entity.status, "read");
  });

  it("deduplicates realtime C7 events by event_id", () => {
    const backend = freshBackend();
    const event = {
      event: "typing.started",
      event_id: "evt-1",
      organization_id: "org-1",
      payload: { conversation_id: "conversation-1" },
    };
    assert.equal(backend.ingestRealtimeEvent(event).duplicate, false);
    assert.equal(backend.ingestRealtimeEvent(event).duplicate, true);
    assert.equal(backend.getMetrics().realtime_duplicate_total, 1);
  });

  it("paginates the change feed with has_more and a moving watermark", () => {
    const backend = freshBackend();
    backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      idempotencyKey: "message-1",
      senderType: "manager",
      text: "one",
    });
    backend.createNotification({
      organizationId: "org-1",
      notificationId: "notification-1",
      recipientUserId: "manager-1",
      title: "Ping",
    });
    backend.sendMessage({
      organizationId: "org-1",
      conversationId: "conversation-1",
      messageId: "message-2",
      idempotencyKey: "message-2",
      senderType: "manager",
      text: "two",
    });

    const firstPage = backend.getChangesSince({ organizationId: "org-1", sinceSequence: 0, limit: 2 });
    assert.equal(firstPage.changes.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.lastSequence, 2);

    const secondPage = backend.getChangesSince({ organizationId: "org-1", sinceSequence: 2, limit: 2 });
    assert.equal(secondPage.changes.length, 1);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.lastSequence, 3);
  });

  it("isolates organizations in listings and the change feed", () => {
    const backend = freshBackend();
    backend.seedConversation({
      organizationId: "org-2",
      conversationId: "conversation-x",
      clientId: "client-x",
      displayName: "Other",
    });
    backend.sendMessage({
      organizationId: "org-2",
      conversationId: "conversation-x",
      messageId: "message-x",
      idempotencyKey: "message-x",
      senderType: "manager",
      text: "foreign",
    });

    assert.equal(backend.currentSequence("org-1"), 0);
    assert.equal(backend.currentSequence("org-2"), 1);
    assert.deepEqual(
      backend.listConversations({ organizationId: "org-1" }).map((c) => c.id),
      ["conversation-1"],
    );
  });
});
