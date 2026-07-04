import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBroadcastCoreDeliveryDraft } from "../../packages/contracts/src/c8.mjs";
import {
  InMemoryCommunicationCoreStore,
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000701";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000007e1";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000007c1";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T11:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function inboundMessage() {
  return {
    id: "40000000-0000-4000-8000-000000000701",
    idempotency_key: "40000000-0000-4000-8000-000000000701",
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: 1,
    type: "text",
    content: { text: "Подпишите меня на новости" },
    status: "received",
    created_at: "2026-07-04T10:00:00.000Z",
    updated_at: "2026-07-04T10:00:00.000Z",
    metadata: {},
  };
}

describe("E2E CP-6 «Broadcast: доставка кампании» через ядро", () => {
  it("SVC-BCAST доставляет кампанию строго через C1/C2 ядра, минуя прямой доступ к адаптеру", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });

    // 1. Клиент пишет в чат — создаётся endpoint и conversation.
    const inbound = await core.acceptIngressMessage(inboundMessage());
    assert.equal(inbound.status, "routed");

    // 2. Egress-адаптер ядра (единая точка доставки во внешний канал).
    const channelDeliveries = [];
    const egressAdapter = {
      async deliver(delivery) {
        channelDeliveries.push(delivery);
        return { accepted: true, status: "sent" };
      },
    };

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter,
      clock: createClock(),
    });

    // 3. SVC-BCAST формирует канонический C8-черновик и отдаёт его ядру.
    const broadcastId = "50000000-0000-4000-8000-000000000701";
    const messageId = "60000000-0000-4000-8000-000000000701";
    const draft = createBroadcastCoreDeliveryDraft({
      broadcastId,
      organizationId: ORGANIZATION_ID,
      messageId,
      conversationId: inbound.conversation_id,
      endpointId: inbound.endpoint_id,
      channel: "web_chat",
      text: "Скидка 20% только сегодня!",
      createdAt: "2026-07-04T11:00:00.000Z",
    });

    const result = await coordinator.deliver(draft);

    // 4. Кампания доставлена через ядро: статусы, связь и попытки.
    assert.equal(result.delivered, true);
    assert.equal(result.status, "sent");
    assert.equal(result.broadcast_message_status, "sent");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, "sent");

    // 5. Во внешний канал ушла ровно одна C2-доставка от ядра.
    assert.equal(channelDeliveries.length, 1);
    assert.equal(channelDeliveries[0].contract, "C2.EgressDelivery");
    assert.equal(channelDeliveries[0].message.message_id, messageId);

    // 6. Сообщение кампании присутствует в диалоге как исходящее broadcast-сообщение.
    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: inbound.conversation_id,
    });
    const broadcastMessage = messages.data.find((message) => message.id === messageId);
    assert.ok(broadcastMessage, "broadcast-сообщение сохранено в диалоге ядра");
    assert.equal(broadcastMessage.direction, "outbound");
    assert.equal(broadcastMessage.sender_type, "broadcast");

    // 7. Повторная отправка того же черновика идемпотентна (дедуп по message_id).
    const duplicate = await coordinator.deliver(draft);
    assert.equal(duplicate.duplicate, true);
    assert.equal(channelDeliveries.length, 1, "повтор не порождает вторую доставку");
    assert.equal(store.getBroadcastMessages().length, 1);
  });
});
