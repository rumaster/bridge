import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBroadcastCoreDeliveryDraft,
} from "../../../../packages/contracts/src/c8.mjs";
import {
  createEdgeTunnelMessage,
  validateEdgeTunnelAck,
} from "../../../../packages/contracts/src/c9.mjs";
import {
  InMemoryCommunicationCoreStore,
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../src/modules/communication-core/index.mjs";
import { createBufferedEdgeGateway } from "../../../edge-gateway/src/buffered-gateway.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000009e1";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000009c1";

const MESSAGE_IDS = {
  1: "30000000-0000-4000-8000-000000000001",
  2: "30000000-0000-4000-8000-000000000002",
  3: "30000000-0000-4000-8000-000000000003",
};

function createClock() {
  let tick = 0;
  return () => `2026-07-04T09:00:00.${String(tick++).padStart(3, "0")}Z`;
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
    content: { text: `msg ${seq}` },
    status: "received",
    created_at: "2026-07-04T08:00:00.000Z",
    updated_at: "2026-07-04T08:00:00.000Z",
    metadata: {},
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonicalMessage({ id, seq }),
    receivedAt: "2026-07-04T08:00:00.000Z",
  });
}

function createCore() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock: createClock() });
  return { store, core };
}

describe("Communication Core M4 — CP-7 приём от SVC-EDGE", () => {
  it("восстанавливает порядок по sequence_number и дедуплицирует повторы в батче", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

    // Буфер SVC-EDGE отдал сообщения не по порядку (3, 1, 2) + повтор seq 1.
    const batch = [
      tunnelMessage({ id: MESSAGE_IDS[3], seq: 3 }),
      tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }),
      tunnelMessage({ id: MESSAGE_IDS[2], seq: 2 }),
      tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }),
    ];

    const result = await intake.intakeBatch(batch);

    assert.equal(result.received, 4);
    assert.equal(result.forwarded, 3, "три уникальных сообщения переданы в ядро");
    assert.equal(result.duplicates, 1, "один повтор внутри батча");
    assert.equal(result.reordered, true, "порядок был восстановлен");
    assert.equal(result.acks.length, 3);

    for (const ack of result.acks) {
      const validation = validateEdgeTunnelAck(ack);
      assert.equal(validation.valid, true, validation.errors.join("\n"));
    }

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.deepEqual(
      messages.data.map((message) => message.sequence_number),
      [1, 2, 3],
      "сообщения сохранены в правильном порядке",
    );
  });

  it("повторный дренаж того же буфера не создаёт дублей в ядре", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

    const batch = [
      tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }),
      tunnelMessage({ id: MESSAGE_IDS[2], seq: 2 }),
      tunnelMessage({ id: MESSAGE_IDS[3], seq: 3 }),
    ];

    const first = await intake.intakeBatch(batch);
    assert.equal(first.forwarded, 3);

    // Повторный дренаж (буфер не был очищен из-за пропущенного ack) — всё дубли.
    const second = await intake.intakeBatch(batch);
    assert.equal(second.forwarded, 0, "повторный дренаж ничего не передаёт");
    assert.equal(second.duplicates, 3, "все сообщения распознаны как дубли");

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.equal(messages.data.length, 3, "в ядре ровно три сообщения");
  });

  it("отклоняет невалидное сообщение туннеля C9", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

    const broken = tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 });
    broken.sequence_number = 999; // рассинхрон с payload

    await assert.rejects(() => intake.intakeBatch([broken]), /Invalid C9 edge tunnel message/);
  });
});

describe("Communication Core M4 — CP-7 буферизующий шлюз SVC-EDGE", () => {
  it("буферизует сообщения офлайн и дренажирует их в порядке ядра при переподключении", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

    const gateway = createBufferedEdgeGateway({
      forward: (messages) => intake.intakeBatch(messages),
      now: createClock(),
      connected: false,
    });

    // Разрыв соединения: сообщения приходят не по порядку и с повтором.
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[3], seq: 3 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[2], seq: 2 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 })); // дубль в буфере

    assert.equal(gateway.bufferedCount(), 3, "дубль не занимает вторую ячейку буфера");

    const drain = await gateway.connect();
    assert.equal(drain.drained, 3);
    assert.equal(drain.result.forwarded, 3);
    assert.equal(drain.result.reordered, true);
    assert.equal(gateway.bufferedCount(), 0, "буфер очищен после дренажа");

    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.deepEqual(
      messages.data.map((message) => message.sequence_number),
      [1, 2, 3],
    );

    const metrics = gateway.getMetrics();
    assert.equal(metrics.buffered_total, 3);
    assert.equal(metrics.drained_total, 3);
  });

  it("онлайн передаёт сообщение сразу, без буферизации", async () => {
    const { core } = createCore();
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

    const gateway = createBufferedEdgeGateway({
      forward: (messages) => intake.intakeBatch(messages),
      now: createClock(),
      connected: true,
    });

    const outcome = await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }));
    assert.equal(outcome.forwarded, true);
    assert.equal(outcome.buffered, false);
    assert.equal(gateway.bufferedCount(), 0);
    assert.equal(outcome.result.forwarded, 1);
  });
});

describe("Communication Core M4 — CP-6 доставка кампаний через ядро", () => {
  async function seedEndpoint(core) {
    const inbound = await core.acceptIngressMessage(
      canonicalMessage({ id: "40000000-0000-4000-8000-000000000001", seq: 1 }),
    );
    return {
      conversationId: inbound.conversation_id,
      endpointId: inbound.endpoint_id,
    };
  }

  function broadcastDraft({ conversationId, endpointId }) {
    return createBroadcastCoreDeliveryDraft({
      broadcastId: "50000000-0000-4000-8000-000000000001",
      organizationId: ORGANIZATION_ID,
      messageId: "60000000-0000-4000-8000-000000000001",
      conversationId,
      endpointId,
      channel: "web_chat",
      text: "Кампания: привет",
      createdAt: "2026-07-04T09:00:00.000Z",
    });
  }

  it("доставляет кампанию через единый механизм ядра с журналом попыток и повтором", async () => {
    const { store, core } = createCore();
    const context = await seedEndpoint(core);

    let calls = 0;
    const flakyAdapter = {
      async deliver() {
        calls += 1;
        if (calls === 1) return { accepted: false, error: "temporary" };
        return { accepted: true, status: "sent" };
      },
    };

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: flakyAdapter,
      clock: createClock(),
      maxAttempts: 3,
    });

    const result = await coordinator.deliver(broadcastDraft(context));

    assert.equal(result.duplicate, false);
    assert.equal(result.delivered, true);
    assert.equal(result.status, "sent");
    assert.equal(result.broadcast_message_status, "sent");
    assert.equal(result.attempts.length, 2, "две попытки: провал + успех");
    assert.equal(result.attempts[0].status, "failed");
    assert.equal(result.attempts[1].status, "sent");

    // broadcast_messages <-> messages связь создана.
    const links = store.getBroadcastMessages();
    assert.equal(links.length, 1);
    assert.equal(links[0].message_id, result.message_id);
    assert.equal(links[0].broadcast_id, result.broadcast_id);

    // Сообщение прошло через ядро как исходящее broadcast-сообщение.
    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: context.conversationId,
    });
    const broadcastMessage = messages.data.find(
      (message) => message.sender_type === "broadcast",
    );
    assert.ok(broadcastMessage, "broadcast-сообщение присутствует в диалоге");
    assert.equal(broadcastMessage.direction, "outbound");
  });

  it("повторный черновик кампании дедуплицируется и не вызывает адаптер снова", async () => {
    const { store, core } = createCore();
    const context = await seedEndpoint(core);

    let calls = 0;
    const adapter = {
      async deliver() {
        calls += 1;
        return { accepted: true, status: "sent" };
      },
    };

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: adapter,
      clock: createClock(),
    });

    const first = await coordinator.deliver(broadcastDraft(context));
    assert.equal(first.delivered, true);
    assert.equal(calls, 1);

    const second = await coordinator.deliver(broadcastDraft(context));
    assert.equal(second.duplicate, true, "повторная доставка распознана как дубль");
    assert.equal(calls, 1, "адаптер не вызван повторно");

    // Одна связь broadcast_messages, без дублей сообщений.
    assert.equal(store.getBroadcastMessages().length, 1);
  });

  it("фиксирует провал доставки после исчерпания попыток", async () => {
    const { store, core } = createCore();
    const context = await seedEndpoint(core);

    const failingAdapter = {
      async deliver() {
        return { accepted: false, error: "permanent" };
      },
    };

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: failingAdapter,
      clock: createClock(),
      maxAttempts: 2,
    });

    const result = await coordinator.deliver(broadcastDraft(context));

    assert.equal(result.delivered, false);
    assert.equal(result.status, "failed");
    assert.equal(result.broadcast_message_status, "failed");
    assert.equal(result.error, "permanent");
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts.at(-1).status, "failed");
  });

  it("отклоняет невалидный C8-черновик до обращения к ядру", async () => {
    const { store, core } = createCore();
    await seedEndpoint(core);

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: { async deliver() { return { accepted: true }; } },
      clock: createClock(),
    });

    await assert.rejects(
      () => coordinator.deliver({ contract: "C8.BroadcastCoreDeliveryDraft" }),
      /Invalid C8 broadcast delivery draft/,
    );
  });
});
