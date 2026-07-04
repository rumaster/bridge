import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBroadcastCoreDeliveryDraft,
  validateBroadcastCoreDeliveryDraft,
} from "../../packages/contracts/src/c8.mjs";
import {
  createEdgeTunnelMessage,
  validateEdgeTunnelAck,
  validateEdgeTunnelMessage,
} from "../../packages/contracts/src/c9.mjs";
import {
  InMemoryCommunicationCoreStore,
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../services/backend/src/modules/communication-core/index.mjs";
import { createBufferedEdgeGateway } from "../../services/edge-gateway/src/buffered-gateway.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000601";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000006e1";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000006c1";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T10:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function canonicalMessage({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `edge ${seq}` },
    status: "received",
    created_at: "2026-07-04T09:00:00.000Z",
    updated_at: "2026-07-04T09:00:00.000Z",
    metadata: {},
  };
}

function createCore() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock: createClock() });
  return { store, core };
}

describe("Контракт EDGE <-> CORE (C9, CP-7) через единый ingress ядра", () => {
  it("буфер SVC-EDGE дренажируется в ядро, порядок восстановлен, ack валидны по C9", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });
    const gateway = createBufferedEdgeGateway({
      forward: (messages) => intake.intakeBatch(messages),
      now: createClock(),
      connected: false,
    });

    const ids = {
      1: "30000000-0000-4000-8000-000000000601",
      2: "30000000-0000-4000-8000-000000000602",
      3: "30000000-0000-4000-8000-000000000603",
    };
    const tunnelMessages = [
      createEdgeTunnelMessage({ payload: canonicalMessage({ id: ids[3], seq: 3 }), receivedAt: "2026-07-04T09:00:00.000Z" }),
      createEdgeTunnelMessage({ payload: canonicalMessage({ id: ids[1], seq: 1 }), receivedAt: "2026-07-04T09:00:00.000Z" }),
      createEdgeTunnelMessage({ payload: canonicalMessage({ id: ids[2], seq: 2 }), receivedAt: "2026-07-04T09:00:00.000Z" }),
    ];

    // Каждое сообщение туннеля соответствует контракту C9.
    for (const tunnelMessage of tunnelMessages) {
      const validation = validateEdgeTunnelMessage(tunnelMessage);
      assert.equal(validation.valid, true, validation.errors.join("\n"));
      await gateway.receive(tunnelMessage);
    }

    const drain = await gateway.connect();
    assert.equal(drain.result.forwarded, 3);
    assert.equal(drain.result.reordered, true);

    // Ответы ядра соответствуют контракту C9.EdgeTunnelAck и несут ключи упорядочивания.
    for (const ack of drain.result.acks) {
      const ackValidation = validateEdgeTunnelAck(ack);
      assert.equal(ackValidation.valid, true, ackValidation.errors.join("\n"));
      assert.equal(ack.accepted, true);
      assert.equal(ack.duplicate, false);
    }

    const orderedAckSequences = drain.result.acks.map((ack) => ack.sequence_number);
    assert.deepEqual(orderedAckSequences, [1, 2, 3], "ack отсортированы по восстановленному порядку");

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.deepEqual(
      messages.data.map((message) => message.sequence_number),
      [1, 2, 3],
    );
  });
});

describe("Контракт BCAST <-> CORE (C8/C1/C2, CP-6) через единый механизм доставки", () => {
  it("C8-черновик доставляется строго через ядро (C1/C2), без обхода адаптером напрямую", async () => {
    const { store, core } = createCore();

    // Входящее сообщение создаёт endpoint и conversation.
    const inbound = await core.acceptIngressMessage(
      canonicalMessage({ id: "40000000-0000-4000-8000-000000000601", seq: 1 }),
    );

    const deliveries = [];
    const egressAdapter = {
      async deliver(delivery) {
        deliveries.push(delivery);
        return { accepted: true, status: "sent" };
      },
    };
    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter,
      clock: createClock(),
    });

    const broadcastId = "50000000-0000-4000-8000-000000000601";
    const messageId = "60000000-0000-4000-8000-000000000601";
    const draft = createBroadcastCoreDeliveryDraft({
      broadcastId,
      organizationId: ORGANIZATION_ID,
      messageId,
      conversationId: inbound.conversation_id,
      endpointId: inbound.endpoint_id,
      channel: "web_chat",
      text: "Здравствуйте из кампании",
      createdAt: "2026-07-04T10:00:00.000Z",
    });

    // Черновик валиден по контракту C8 и канонической модели C1.
    const draftValidation = validateBroadcastCoreDeliveryDraft(draft);
    assert.equal(draftValidation.valid, true, draftValidation.errors.join("\n"));
    assert.equal(draft.delivery_path, "C1/C2");
    assert.deepEqual(draft.core_contracts, ["C1", "C2"]);

    const result = await coordinator.deliver(draft);
    assert.equal(result.delivered, true);
    assert.equal(result.status, "sent");
    assert.equal(result.broadcast_message_status, "sent");

    // Доставка прошла через C2 egress ядра (адаптер получил ровно одну C2-доставку).
    assert.equal(deliveries.length, 1, "адаптер вызван через единый C2-путь ядра");
    assert.equal(deliveries[0].contract, "C2.EgressDelivery");
    assert.equal(deliveries[0].idempotency_key, messageId);
    assert.equal(deliveries[0].message.message_id, messageId);
    assert.equal(deliveries[0].message.direction, "outbound");

    // Связь broadcast_messages <-> messages зафиксирована.
    const links = store.getBroadcastMessages();
    assert.equal(links.length, 1);
    assert.equal(links[0].message_id, messageId);
    assert.equal(links[0].broadcast_id, broadcastId);
  });
});
