import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
} from "../../../backend/src/modules/communication-core/index.mjs";
import { createCampaignRunner } from "../../src/campaign/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function canonicalInbound({ id, endpointId, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORGANIZATION_ID,
    conversation_id: `20000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    endpoint_id: endpointId,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: 1,
    type: "text",
    content: { text: `seed ${seq}` },
    status: "received",
    created_at: "2026-07-04T08:00:00.000Z",
    updated_at: "2026-07-04T08:00:00.000Z",
    metadata: {},
  };
}

/**
 * Материализует получателя, засеяв его endpoint/диалог в ядре (как это делает
 * реальный поток C1). Возвращает канонические id для C8-черновика.
 */
async function seedRecipient(core, index) {
  const endpointId = `10000000-0000-4000-8000-0000000009${String(index).padStart(2, "0")}`;
  const inbound = await core.acceptIngressMessage(
    canonicalInbound({
      id: `40000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
      endpointId,
      seq: index,
    }),
  );
  return {
    client_id: `client-${index}`,
    endpoint_id: inbound.endpoint_id,
    conversation_id: inbound.conversation_id,
    channel: "web_chat",
    sequence_number: 1,
    context: { client: { name: `Клиент ${index}` } },
  };
}

const broadcast = {
  id: "50000000-0000-4000-8000-000000000001",
  organization_id: ORGANIZATION_ID,
  status: "scheduled",
  template: { type: "text", body: "Здравствуйте, {{client.name}}" },
  rate_limit: { messages_per_minute: 600 },
};

describe("BCAST <-> CORE контракт (CP-6): доставка строго через единый механизм ядра", () => {
  it("доставляет кампанию через реальный координатор ядра со связью broadcast_messages", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });
    const recipients = [await seedRecipient(core, 1), await seedRecipient(core, 2)];

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: { async deliver() { return { accepted: true, status: "sent" }; } },
      clock: createClock(),
    });
    const runner = createCampaignRunner({ core: coordinator, clock: createClock(), sleep: async () => {} });

    const result = await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });

    assert.equal(result.status, "done");
    assert.equal(result.stats.prepared, 2);
    assert.equal(result.stats.sent, 2);
    assert.equal(result.stats.failed, 0);

    // Ядро связало broadcast_messages <-> messages и провело исходящие сообщения.
    const links = store.getBroadcastMessages();
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.broadcast_id, broadcast.id);
      assert.equal(link.status, "sent");
    }
  });

  it("повторный запуск с тем же ключом идемпотентен: ядро не создаёт дублей", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });
    const recipients = [await seedRecipient(core, 1), await seedRecipient(core, 2)];

    let egressCalls = 0;
    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: {
        async deliver() {
          egressCalls += 1;
          return { accepted: true, status: "sent" };
        },
      },
      clock: createClock(),
    });
    const runner = createCampaignRunner({ core: coordinator, clock: createClock(), sleep: async () => {} });

    await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });
    const second = await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });

    assert.equal(egressCalls, 2, "адаптер вызван только на первом запуске (2 получателя)");
    assert.ok(second.results.every((r) => r.duplicate === true), "повтор распознан как дубли");
    assert.equal(store.getBroadcastMessages().length, 2, "нет дублей broadcast_messages");
  });

  it("транзиентный отказ адаптера доводится ядром до успеха (журнал попыток)", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });
    const recipients = [await seedRecipient(core, 1)];

    let calls = 0;
    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: {
        async deliver() {
          calls += 1;
          if (calls === 1) return { accepted: false, error: "temporary" };
          return { accepted: true, status: "sent" };
        },
      },
      clock: createClock(),
      maxAttempts: 3,
    });
    const runner = createCampaignRunner({ core: coordinator, clock: createClock(), sleep: async () => {} });

    const result = await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });

    assert.equal(result.stats.sent, 1, "ядро повторило доставку и добилось успеха");
    assert.equal(store.getBroadcastMessages()[0].status, "sent");
  });
});
