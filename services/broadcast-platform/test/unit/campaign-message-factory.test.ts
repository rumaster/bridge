import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBroadcastCoreDeliveryDraft } from "../../../../packages/contracts/src/c8.js";
import {
  buildBroadcastDraft,
  channelSupportsType,
  deriveMessageId,
} from "../../src/campaign/index.js";

const broadcast = {
  id: "50000000-0000-4000-8000-000000000001",
  organization_id: "10000000-0000-4000-8000-000000000101",
  template: { type: "text", body: "Здравствуйте, {{client.name}}" },
  rate_limit: { messages_per_minute: 60 },
};

const recipient = {
  client_id: "client-1",
  endpoint_id: "10000000-0000-4000-8000-0000000009e1",
  conversation_id: "20000000-0000-4000-8000-0000000009c1",
  channel: "web_chat",
  sequence_number: 1,
  context: { client: { name: "Мария" } },
};

describe("SVC-BCAST M4 — идемпотентная генерация сообщений ядра (C1, ТЗ §11.12)", () => {
  it("строит валидный C8-черновик: sender_type=broadcast, idempotency_key=message_id, C1/C2", () => {
    const { draft, message_id } = buildBroadcastDraft({
      broadcast,
      recipient,
      startIdempotencyKey: "start-key-1",
      createdAt: "2026-07-04T10:00:00.000Z",
    });

    const validation = validateBroadcastCoreDeliveryDraft(draft);
    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.equal(draft.sender_type, "broadcast");
    assert.equal(draft.delivery_path, "C1/C2");
    assert.equal(draft.message.id, message_id);
    assert.equal(draft.message.idempotency_key, message_id);
    assert.equal(draft.message.content.text, "Здравствуйте, Мария");
  });

  it("детерминированный message_id: тот же (кампания, получатель, ключ) -> тот же id", () => {
    const args = { broadcastId: broadcast.id, recipient, startIdempotencyKey: "start-key-1" };
    assert.equal(deriveMessageId(args), deriveMessageId(args));
  });

  it("разный ключ запуска даёт разные message_id (новый запуск — новые сообщения)", () => {
    const first = deriveMessageId({
      broadcastId: broadcast.id,
      recipient,
      startIdempotencyKey: "start-key-1",
    });
    const second = deriveMessageId({
      broadcastId: broadcast.id,
      recipient,
      startIdempotencyKey: "start-key-2",
    });
    assert.notEqual(first, second);
  });

  it("разные получатели одной кампании получают разные message_id", () => {
    const other = { ...recipient, client_id: "client-2", endpoint_id: "10000000-0000-4000-8000-0000000009e2" };
    assert.notEqual(
      deriveMessageId({ broadcastId: broadcast.id, recipient, startIdempotencyKey: "k" }),
      deriveMessageId({ broadcastId: broadcast.id, recipient: other, startIdempotencyKey: "k" }),
    );
  });

  it("M5: массовая генерация не даёт коллизий и сохраняет idempotency_key = message_id", () => {
    const recipients = Array.from({ length: 1_000 }, (_unused, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return {
        ...recipient,
        client_id: `client-load-${index + 1}`,
        endpoint_id: `10000000-0000-4000-8000-${suffix}`,
        conversation_id: `20000000-0000-4000-8000-${suffix}`,
        context: { client: { name: `Клиент ${index + 1}` } },
      };
    });

    const firstPass = recipients.map((item) =>
      buildBroadcastDraft({
        broadcast,
        recipient: item,
        startIdempotencyKey: "m5-load-start",
        createdAt: "2026-07-04T10:00:00.000Z",
      }),
    );
    const secondPass = recipients.map((item) =>
      deriveMessageId({
        broadcastId: broadcast.id,
        recipient: item,
        startIdempotencyKey: "m5-load-start",
      }),
    );

    const messageIds = firstPass.map(({ message_id }) => message_id);
    assert.equal(new Set(messageIds).size, recipients.length, "коллизий message_id нет");
    assert.deepEqual(messageIds, secondPass, "повторная генерация детерминирована");

    for (const { draft, message_id } of firstPass) {
      assert.equal(draft.message.id, message_id);
      assert.equal(draft.message.idempotency_key, message_id);
    }
  });
});

describe("SVC-BCAST M4 — совместимость канала по Capability (C6)", () => {
  it("без дескриптора канал считается совместимым", () => {
    assert.equal(channelSupportsType(undefined, "text"), true);
  });

  it("канал совместим только при capabilities[type].supported === true", () => {
    assert.equal(
      channelSupportsType({ capabilities: { text: { supported: true } } }, "text"),
      true,
    );
    assert.equal(
      channelSupportsType({ capabilities: { text: { supported: false } } }, "text"),
      false,
    );
    assert.equal(channelSupportsType({ capabilities: {} }, "text"), false);
  });
});
