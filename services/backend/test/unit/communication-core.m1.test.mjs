import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  assertStatusTransition,
  createCommunicationCoreM1Service,
} from "../../src/modules/communication-core/communication-core-m1.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const INBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000601";
const OUTBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000602";

function createCore() {
  const deliveries = [];
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({
    store,
    clock: () => "2026-07-03T10:00:00.000Z",
    egressAdapter: {
      async deliver(delivery) {
        deliveries.push(delivery);
        return {
          accepted: true,
          duplicate: false,
          status: "sent",
        };
      },
    },
  });

  return { core, deliveries, store };
}

function ingressEnvelope(overrides = {}) {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: INBOUND_MESSAGE_ID,
    received_at: "2026-07-03T09:59:59.000Z",
    message: {
      message_id: INBOUND_MESSAGE_ID,
      organization_id: ORGANIZATION_ID,
      channel_id: "web-chat-channel",
      channel_type: "web_chat",
      external_message_id: "web-chat-message-1",
      conversation_ref: "web-chat-room-1",
      sender_ref: "visitor-1",
      direction: "inbound",
      content: {
        type: "text",
        text: "Need help",
      },
      attachments: [
        {
          id: "10000000-0000-4000-8000-000000000701",
          kind: "image",
          storage_ref: "s3://bridge-test/help.png",
          mime: "image/png",
          size: 128,
        },
      ],
      occurred_at: "2026-07-03T09:59:59.000Z",
    },
    ...overrides,
  };
}

describe("Communication Core M1", () => {
  it("фиксирует конечный автомат received -> routed -> sent", () => {
    assert.equal(assertStatusTransition("received", "routed"), true);
    assert.equal(assertStatusTransition("routed", "sent"), true);
    assert.equal(assertStatusTransition("received", "sent"), false);
  });

  it("принимает C2 ingress, создаёт Conversation, сохраняет вложение и маршрутизирует менеджеру", async () => {
    const { core } = createCore();

    const accepted = await core.acceptIngressMessage(ingressEnvelope());

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.message_id, INBOUND_MESSAGE_ID);
    assert.equal(accepted.organization_id, ORGANIZATION_ID);
    assert.equal(accepted.status, "routed");
    assert.equal(accepted.routed_to, "manager");

    const conversations = await core.listConversations({ organizationId: ORGANIZATION_ID });
    assert.equal(conversations.data.length, 1);
    assert.equal(conversations.data[0].status, "open");
    assert.equal(conversations.data[0].last_message_at, "2026-07-03T09:59:59.000Z");

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: accepted.conversation_id,
    });
    assert.equal(messages.data.length, 1);
    assert.equal(messages.data[0].status, "routed");
    assert.equal(messages.data[0].attachments.length, 1);
    assert.equal(messages.data[0].attachments[0].storage_ref, "s3://bridge-test/help.png");
  });

  it("делает ingress идемпотентным по idempotency_key", async () => {
    const { core } = createCore();

    const first = await core.acceptIngressMessage(ingressEnvelope());
    const second = await core.acceptIngressMessage(ingressEnvelope());

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.message_id, first.message_id);

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: first.conversation_id,
    });
    assert.equal(messages.data.length, 1);
  });

  it("отклоняет C2 ingress с drift или не-UUID idempotency key", async () => {
    const { core } = createCore();
    const drifted = ingressEnvelope({
      idempotency_key: "10000000-0000-4000-8000-000000000699",
    });
    const nonUuid = ingressEnvelope();
    nonUuid.idempotency_key = "adapter-message-1";
    nonUuid.message.message_id = "adapter-message-1";

    await assert.rejects(
      () => core.acceptIngressMessage(drifted),
      /idempotency_key must match message\.message_id/,
    );
    await assert.rejects(
      () => core.acceptIngressMessage(nonUuid),
      /idempotency_key must be a UUID string/,
    );
  });

  it("создаёт исходящее сообщение менеджера, передаёт egress в SVC-INT и пишет delivery attempt", async () => {
    const { core, deliveries, store } = createCore();
    const inbound = await core.acceptIngressMessage(ingressEnvelope());

    const outbound = await core.sendManagerMessage({
      idempotency_key: OUTBOUND_MESSAGE_ID,
      organization_id: ORGANIZATION_ID,
      conversation_id: inbound.conversation_id,
      sender_type: "manager",
      type: "text",
      content: {
        text: "Hello, I can help",
      },
    });

    assert.equal(outbound.accepted, true);
    assert.equal(outbound.duplicate, false);
    assert.equal(outbound.status, "sent");
    assert.equal(outbound.delivery_attempt.status, "sent");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].contract, "C2.EgressDelivery");
    assert.equal(deliveries[0].message.direction, "outbound");
    assert.equal(deliveries[0].message.content.text, "Hello, I can help");

    const attempts = store.getDeliveryAttempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].message_id, OUTBOUND_MESSAGE_ID);
    assert.equal(attempts[0].attempt_no, 1);
    assert.equal(attempts[0].status, "sent");
  });
});
