import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWebSocketEvent,
  validateWebSocketEvent,
} from "../../../../packages/contracts/src/c7.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createInMemoryC7EventPublisher,
} from "../../src/modules/communication-core/communication-core-m1.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000201";
const MESSAGE_1 = "10000000-0000-4000-8000-000000000701";
const MESSAGE_2 = "10000000-0000-4000-8000-000000000702";
const MESSAGE_3 = "10000000-0000-4000-8000-000000000703";
const MESSAGE_4 = "10000000-0000-4000-8000-000000000704";

function createCore() {
  const store = new InMemoryCommunicationCoreStore();
  const realtimePublisher = createInMemoryC7EventPublisher({
    clock: () => "2026-07-03T11:00:00.000Z",
  });
  const core = createCommunicationCoreM1Service({
    store,
    realtimePublisher,
    clock: () => "2026-07-03T11:00:00.000Z",
  });

  return { core, realtimePublisher, store };
}

function ingressEnvelope({
  channelId = "web-chat-channel",
  channelType = "web_chat",
  conversationRef = "room-1",
  identity,
  messageId = MESSAGE_1,
  occurredAt = "2026-07-03T10:59:00.000Z",
  senderRef = "visitor-1",
  sequenceNumber,
} = {}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: occurredAt,
    message: {
      message_id: messageId,
      organization_id: ORGANIZATION_ID,
      channel_id: channelId,
      channel_type: channelType,
      external_message_id: `external-${messageId}`,
      conversation_ref: conversationRef,
      sender_ref: senderRef,
      direction: "inbound",
      ...(sequenceNumber ? { sequence_number: sequenceNumber } : {}),
      ...(identity ? { identity } : {}),
      content: {
        type: "text",
        text: `message ${messageId}`,
      },
      occurred_at: occurredAt,
    },
  };
}

describe("Communication Core M2", () => {
  it("не объединяет endpoint по неверифицированному совпадению identity", async () => {
    const { core, store } = createCore();
    const identity = {
      link_type: "verified_email",
      value: "same@example.bridge.local",
      verified: false,
    };

    await core.acceptIngressMessage(
      ingressEnvelope({
        identity,
        messageId: MESSAGE_1,
        senderRef: "visitor-a",
      }),
    );
    await core.acceptIngressMessage(
      ingressEnvelope({
        channelId: "telegram-channel",
        channelType: "telegram",
        conversationRef: "telegram-chat-1",
        identity,
        messageId: MESSAGE_2,
        senderRef: "telegram-user-a",
      }),
    );

    const conversations = await core.listConversations({ organizationId: ORGANIZATION_ID });
    assert.equal(conversations.data.length, 2);
    assert.equal(new Set(conversations.data.map((item) => item.client_id)).size, 2);
    assert.equal(store.getIdentityLinks().length, 0);
  });

  it("автоматически связывает endpoint только по verified identity и ведёт единую историю", async () => {
    const { core, store } = createCore();
    const identity = {
      link_type: "verified_email",
      value: "verified@example.bridge.local",
      verified: true,
    };

    const first = await core.acceptIngressMessage(
      ingressEnvelope({
        identity,
        messageId: MESSAGE_1,
        occurredAt: "2026-07-03T10:59:00.000Z",
        senderRef: "visitor-a",
      }),
    );
    const second = await core.acceptIngressMessage(
      ingressEnvelope({
        channelId: "telegram-channel",
        channelType: "telegram",
        conversationRef: "telegram-chat-1",
        identity,
        messageId: MESSAGE_2,
        occurredAt: "2026-07-03T10:59:05.000Z",
        senderRef: "telegram-user-a",
      }),
    );

    assert.equal(second.conversation_id, first.conversation_id);
    assert.equal(first.sequence_number, 1);
    assert.equal(second.sequence_number, 1);

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: first.conversation_id,
    });
    assert.deepEqual(messages.data.map((message) => message.id), [MESSAGE_1, MESSAGE_2]);
    assert.equal(store.getIdentityLinks().length, 2);
    assert.deepEqual(
      store.getIdentityLinks().map((link) => link.link_type),
      ["verified_email", "verified_email"],
    );
  });

  it("ручное объединение переносит историю и обратимо через reverted_at", async () => {
    const { core, store } = createCore();
    const target = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: MESSAGE_1,
        occurredAt: "2026-07-03T10:59:00.000Z",
        senderRef: "visitor-a",
      }),
    );
    const source = await core.acceptIngressMessage(
      ingressEnvelope({
        channelId: "telegram-channel",
        channelType: "telegram",
        conversationRef: "telegram-chat-1",
        messageId: MESSAGE_2,
        occurredAt: "2026-07-03T10:59:05.000Z",
        senderRef: "telegram-user-a",
      }),
    );
    const conversations = await core.listConversations({ organizationId: ORGANIZATION_ID });
    const sourceConversation = conversations.data.find((item) => item.id === source.conversation_id);
    const targetConversation = conversations.data.find((item) => item.id === target.conversation_id);

    const merge = await core.mergeClients({
      actorUserId: ACTOR_USER_ID,
      organizationId: ORGANIZATION_ID,
      reason: "Manager confirmed duplicate client",
      sourceClientId: sourceConversation.client_id,
      targetClientId: targetConversation.client_id,
    });

    assert.equal(merge.accepted, true);
    assert.equal(merge.mode, "core-m2");
    assert.equal(merge.moved_message_count, 1);

    const mergedMessages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: target.conversation_id,
    });
    assert.deepEqual(mergedMessages.data.map((message) => message.id), [MESSAGE_1, MESSAGE_2]);

    const reverted = await core.revertIdentityLink({
      actorUserId: ACTOR_USER_ID,
      linkId: merge.links[0].id,
      organizationId: ORGANIZATION_ID,
      reason: "Wrong manual merge",
    });

    assert.equal(reverted.reverted, true);
    assert.equal(reverted.reverted_link.reverted_at, "2026-07-03T11:00:00.000Z");
    assert.equal(store.getIdentityLinks()[0].reverted_at, "2026-07-03T11:00:00.000Z");

    const restoredSourceMessages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: source.conversation_id,
    });
    const restoredTargetMessages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: target.conversation_id,
    });
    assert.deepEqual(restoredSourceMessages.data.map((message) => message.id), [MESSAGE_2]);
    assert.deepEqual(restoredTargetMessages.data.map((message) => message.id), [MESSAGE_1]);
  });

  it("назначает sequence_number на уровне endpoint и обнаруживает пропуски", async () => {
    const { core } = createCore();
    const first = await core.acceptIngressMessage(
      ingressEnvelope({ messageId: MESSAGE_1, senderRef: "visitor-a" }),
    );
    const third = await core.acceptIngressMessage(
      ingressEnvelope({
        messageId: MESSAGE_3,
        senderRef: "visitor-a",
        sequenceNumber: 3,
      }),
    );

    assert.equal(first.sequence_number, 1);
    assert.equal(third.sequence_number, 3);
    assert.deepEqual(third.sequence_gap, {
      endpoint_id: first.endpoint_id,
      expected_sequence_number: 2,
      received_sequence_number: 3,
    });

    const gaps = await core.detectSequenceGaps({
      endpointId: first.endpoint_id,
      organizationId: ORGANIZATION_ID,
    });
    assert.deepEqual(gaps, [
      {
        after_sequence_number: 1,
        expected_sequence_number: 2,
        received_sequence_number: 3,
      },
    ]);
  });

  it("публикует C7 message/typing/client события в realtime publisher", async () => {
    const { core, realtimePublisher } = createCore();
    const accepted = await core.acceptIngressMessage(ingressEnvelope({ messageId: MESSAGE_4 }));

    await core.publishTypingEvent({
      actorType: "client",
      conversationId: accepted.conversation_id,
      endpointId: accepted.endpoint_id,
      organizationId: ORGANIZATION_ID,
      typing: true,
    });
    await core.publishClientStatusChanged({
      clientId: accepted.client_id,
      organizationId: ORGANIZATION_ID,
      status: "online",
    });

    const events = realtimePublisher.getEvents();
    assert.deepEqual(events.map((event) => event.event), [
      "message.created",
      "message.status_changed",
      "typing.started",
      "client.status_changed",
    ]);

    for (const event of events) {
      assert.equal(validateWebSocketEvent(event).valid, true);
    }
  });

  it("выбирает канал по C6 capabilities, а не по имени канала", async () => {
    const { core, store } = createCore();
    store.upsertChannelCapabilities({
      capabilities: { text: true, voice: false },
      channelId: "telegram-channel",
      channelType: "telegram",
      organizationId: ORGANIZATION_ID,
    });
    store.upsertChannelCapabilities({
      capabilities: { text: true, voice: true },
      channelId: "email-channel",
      channelType: "email",
      organizationId: ORGANIZATION_ID,
    });

    const selected = await core.selectDeliveryChannel({
      organizationId: ORGANIZATION_ID,
      requiredCapabilities: ["voice"],
    });

    assert.equal(selected.channel_id, "email-channel");
    assert.equal(selected.channel_type, "email");
  });

  it("валидирует формат события C7 из контракта", () => {
    const event = createWebSocketEvent({
      event: "message.created",
      eventId: "event-1",
      organizationId: ORGANIZATION_ID,
      payload: { message_id: MESSAGE_1 },
      sequenceNumber: 1,
    });

    assert.equal(validateWebSocketEvent(event).valid, true);
  });
});
