import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../packages/contracts/src/c9.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../services/backend/src/modules/communication-core/index.mjs";
import { createBufferedEdgeGateway } from "../../services/edge-gateway/src/buffered-gateway.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000801";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000008e1";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000008c1";

const IDS = {
  1: "30000000-0000-4000-8000-000000000801",
  2: "30000000-0000-4000-8000-000000000802",
  3: "30000000-0000-4000-8000-000000000803",
  4: "30000000-0000-4000-8000-000000000804",
};

function createClock() {
  let tick = 0;
  return () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;
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
    created_at: "2026-07-04T11:00:00.000Z",
    updated_at: "2026-07-04T11:00:00.000Z",
    metadata: {},
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonicalMessage({ id, seq }),
    receivedAt: "2026-07-04T11:00:00.000Z",
  });
}

describe("E2E CP-7 «Потеря соединения»: восстановление порядка и дедупликация", () => {
  it("буфер SVC-EDGE переживает разрыв и дренажирует в ядро с восстановлением порядка", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });
    const gateway = createBufferedEdgeGateway({
      forward: (messages) => intake.intakeBatch(messages),
      now: createClock(),
      connected: true,
    });

    // 1. Онлайн: первое сообщение доставляется в ядро немедленно.
    const online = await gateway.receive(tunnelMessage({ id: IDS[1], seq: 1 }));
    assert.equal(online.forwarded, true);
    assert.equal(online.result.forwarded, 1);

    // 2. Разрыв соединения: сообщения копятся в буфере, приходят не по порядку и с повтором.
    gateway.disconnect();
    assert.equal(gateway.isConnected(), false);

    await gateway.receive(tunnelMessage({ id: IDS[3], seq: 3 }));
    await gateway.receive(tunnelMessage({ id: IDS[2], seq: 2 }));
    await gateway.receive(tunnelMessage({ id: IDS[4], seq: 4 }));
    await gateway.receive(tunnelMessage({ id: IDS[2], seq: 2 })); // повтор во время разрыва

    assert.equal(gateway.bufferedCount(), 3, "повтор не занимает вторую ячейку буфера");

    // 3. Восстановление соединения: буфер дренажируется одним батчем, порядок восстановлен.
    const drain = await gateway.connect();
    assert.equal(gateway.isConnected(), true);
    assert.equal(drain.drained, 3);
    assert.equal(drain.result.forwarded, 3);
    assert.equal(drain.result.reordered, true);
    assert.equal(gateway.bufferedCount(), 0, "буфер очищен после дренажа");

    // 4. В ядре сообщения лежат строго по возрастанию sequence_number.
    const messages = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.deepEqual(
      messages.data.map((message) => message.sequence_number),
      [1, 2, 3, 4],
    );

    // 5. Повторный дренаж того же набора (например, потерянные ack) — без дублей в ядре.
    const redrain = await intake.intakeBatch([
      tunnelMessage({ id: IDS[2], seq: 2 }),
      tunnelMessage({ id: IDS[3], seq: 3 }),
      tunnelMessage({ id: IDS[4], seq: 4 }),
    ]);
    assert.equal(redrain.forwarded, 0);
    assert.equal(redrain.duplicates, 3);

    const afterRedrain = await core.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.equal(afterRedrain.data.length, 4, "повторный дренаж не создаёт дублей");

    const metrics = gateway.getMetrics();
    assert.equal(metrics.buffered_total, 3);
    assert.equal(metrics.drained_total, 3);
    assert.equal(metrics.forwarded_online_total, 1);
  });
});
