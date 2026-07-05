import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createWebSocketEvent } from "../../packages/contracts/src/c7.js";
import { createEdgeTunnelMessage } from "../../packages/contracts/src/c9.js";
import { createBufferedEdgeGateway } from "../../services/edge-gateway/src/buffered-gateway.js";
import { createMockWebSocketChannel } from "../../services/edge-gateway/src/mock-ws-channel.js";
import { createMobileBff } from "../../services/mobile-api/src/mobile-bff.js";
import { createMobileApiServer } from "../../services/mobile-api/src/server.js";

// E2E CP-7 «Потеря соединения», мобильная часть (ТЗ §19.3–§19.5, §7.9/§7.10, §11.12).
// RF-клиент шлёт канонические сообщения в ядро через SVC-EDGE (туннель C9). На
// разрыве Ed-буфер накапливает их (дедуп по idempotency_key), после восстановления
// дренажирует в мобильный BFF, который восстанавливает порядок по sequence_number и
// снимает дубли. Мобильный клиент затем догоняет состояние по GET /mobile/v1/sync —
// без потерь, дублей и нарушения порядка. Второй сценарий — мобильный realtime C7:
// реконнект WS с реплеем пропущенных событий, идемпотентным к повторам.

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000801";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000008e1";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000008c1";
const MANAGER_ID = "10000000-0000-4000-8000-0000000008f1";
const MOBILE_DEVICE_ID = "device-mobile-rf";

// Мобильный принципал (получатель), от лица которого идёт оффлайн-sync.
const MOBILE_CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: MANAGER_ID,
  deviceId: MOBILE_DEVICE_ID,
};

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

// Каноническое входящее сообщение RF-клиента (как его видит ядро из Edge).
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as any };
}

function syncPath(cursor?) {
  const params = new URLSearchParams({ device_id: MOBILE_DEVICE_ID });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return `/mobile/v1/sync?${params.toString()}`;
}

describe("E2E CP-7 mobile «Потеря соединения»: RF-клиент через Edge → sync без потерь/дублей/переупорядочивания", () => {
  let server;
  let baseUrl;
  let bff;
  let gateway;

  before(async () => {
    bff = createMobileBff({ now: createClock(), context: MOBILE_CONTEXT });
    gateway = createBufferedEdgeGateway({
      forward: (messages) => bff.ingestEdgeBatch(messages),
      now: createClock(),
      connected: true,
    });
    server = createMobileApiServer({ mobileApi: bff });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("после разрыва и восстановления мобильный sync отдаёт восстановленную ленту ровно один раз в строгом порядке", async () => {
    // 0. Мобильный клиент онлайн: снимает стартовый курсор на пустой ленте.
    const baseline = await getJson(baseUrl, syncPath());
    assert.equal(baseline.status, 200);
    assert.equal(baseline.body.deltas.messages.length, 0);

    // 1. Онлайн: первое RF-сообщение из Edge доставляется в BFF немедленно.
    const online = await gateway.receive(tunnelMessage({ id: IDS[1], seq: 1 }));
    assert.equal(online.forwarded, true);
    assert.equal(online.result.ingested, 1);

    // 2. Разрыв Edge↔ядро: RF-сообщения копятся в буфере — не по порядку и с повтором.
    gateway.disconnect();
    assert.equal(gateway.isConnected(), false);
    await gateway.receive(tunnelMessage({ id: IDS[3], seq: 3 }));
    await gateway.receive(tunnelMessage({ id: IDS[2], seq: 2 }));
    await gateway.receive(tunnelMessage({ id: IDS[4], seq: 4 }));
    await gateway.receive(tunnelMessage({ id: IDS[2], seq: 2 })); // повтор во время разрыва
    assert.equal(gateway.bufferedCount(), 3, "повтор не занимает вторую ячейку буфера");

    // 3. Восстановление: буфер дренажируется в BFF, ядро восстанавливает порядок и снимает дубли.
    const drain = await gateway.connect();
    assert.equal(gateway.isConnected(), true);
    assert.equal(drain.drained, 3);
    assert.deepEqual(
      {
        ingested: drain.result.ingested,
        duplicates: drain.result.duplicates,
        ordered: drain.result.ordered,
      },
      { ingested: 3, duplicates: 0, ordered: true },
    );
    assert.equal(gateway.bufferedCount(), 0, "буфер очищен после дренажа");

    // 4. Мобильный клиент догоняет по своему курсору: 4 сообщения строго по возрастанию,
    //    без дублей и потерь.
    const resumed = await getJson(baseUrl, syncPath(baseline.body.cursor));
    const sequences = resumed.body.deltas.messages.map((message) => message.sequence_number);
    const ids = resumed.body.deltas.messages.map((message) => message.message_id);
    assert.deepEqual(sequences, [1, 2, 3, 4], "порядок восстановлен по sequence_number");
    assert.deepEqual(ids, [IDS[1], IDS[2], IDS[3], IDS[4]], "получены все сообщения без потерь");
    assert.equal(new Set(ids).size, 4, "нет дублей");

    // 5. Догоняющий sync по новому курсору — пусто (клиент полностью синхронизирован).
    const caughtUp = await getJson(baseUrl, syncPath(resumed.body.cursor));
    assert.equal(caughtUp.body.deltas.messages.length, 0);

    // 6. Потерянные ack: повторный дренаж того же набора не создаёт дублей в ленте.
    const redrain = bff.ingestEdgeBatch([
      tunnelMessage({ id: IDS[2], seq: 2 }),
      tunnelMessage({ id: IDS[3], seq: 3 }),
      tunnelMessage({ id: IDS[4], seq: 4 }),
    ]);
    assert.deepEqual(
      { ingested: redrain.ingested, duplicates: redrain.duplicates },
      { ingested: 0, duplicates: 3 },
    );

    // 7. Стабильное чтение: повтор sync по стартовому курсору отдаёт тот же срез
    //    (те же 4 сообщения, без дублей) — идемпотентность восстановления.
    const replay = await getJson(baseUrl, syncPath(baseline.body.cursor));
    assert.deepEqual(
      replay.body.deltas.messages.map((message) => message.sequence_number),
      [1, 2, 3, 4],
    );
    assert.equal(
      new Set(replay.body.deltas.messages.map((message) => message.message_id)).size,
      4,
    );

    // 8. В BFF-ленте разговора сообщения лежат строго по sequence_number и без дублей.
    const stored = bff.backend.listConversationMessages({
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
    });
    assert.deepEqual(stored.map((message) => message.sequence_number), [1, 2, 3, 4]);

    // 9. Метрики шлюза: одно онлайн-сообщение, три буферизованных, три дренажированных.
    const metrics = gateway.getMetrics();
    assert.equal(metrics.forwarded_online_total, 1);
    assert.equal(metrics.buffered_total, 3);
    assert.equal(metrics.drained_total, 3);
  });
});

describe("E2E CP-7 mobile realtime: реконнект WS C7 без потерь и дублей, sync добивает ленту", () => {
  let server;
  let baseUrl;
  let bff;
  let wsChannel;

  before(async () => {
    wsChannel = createMockWebSocketChannel();
    bff = createMobileBff({ now: createClock(), context: MOBILE_CONTEXT, wsChannel });
    server = createMobileApiServer({ mobileApi: bff });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  function publish({ eventId, seq }) {
    return wsChannel.publish(
      createWebSocketEvent({
        eventId,
        organizationId: ORGANIZATION_ID,
        event: "message.created",
        sequenceNumber: seq,
        occurredAt: `2026-07-04T11:00:0${seq}.000Z`,
        payload: {
          message_id: IDS[seq],
          conversation_id: CONVERSATION_ID,
          sequence_number: seq,
          sender_type: "client",
          text: `rf ${seq}`,
        },
      }),
    );
  }

  it("пропущенные события догоняются реплеем ровно один раз, повторный реплей идемпотентен", async () => {
    // 0. Стартовый курсор мобильного клиента на пустой ленте.
    const baseline = await getJson(baseUrl, syncPath());
    assert.equal(baseline.body.deltas.messages.length, 0);

    // 1. До подписки в C7 опубликованы два события; ещё одно придёт «живым» после подключения.
    publish({ eventId: "evt-rf-1", seq: 1 });
    publish({ eventId: "evt-rf-2", seq: 2 });

    // 2. Мобильный клиент подключается к C7: реплей evt1/evt2 + живой evt3.
    const subscription = bff.connectRealtime({ subscription: { organizationId: ORGANIZATION_ID } });
    publish({ eventId: "evt-rf-3", seq: 3 });
    assert.equal(bff.realtimeConsumer.getMetrics().realtime_message_created_total, 3);
    const lastEventId = subscription.lastEventId;
    assert.equal(lastEventId, "evt-rf-3");

    // 3. Разрыв WS: событие evt4 приходит, пока клиента нет; повтор evt3 дедуплицируется каналом.
    subscription.close();
    publish({ eventId: "evt-rf-4", seq: 4 });
    const duplicate = publish({ eventId: "evt-rf-3", seq: 3 });
    assert.equal(duplicate.duplicate, true);
    assert.equal(wsChannel.getMetrics().duplicate_event_total, 1);

    // 4. Реконнект с курсором lastEventId: реплеится ровно пропущенное evt4 (без повторов виденного).
    const ingestedBefore = bff.backend.getMetrics().realtime_ingested_total;
    const resume = bff.connectRealtime({
      subscription: { organizationId: ORGANIZATION_ID },
      lastEventId,
    });
    assert.equal(bff.realtimeConsumer.getMetrics().realtime_message_created_total, 4);
    assert.equal(
      bff.backend.getMetrics().realtime_ingested_total - ingestedBefore,
      1,
      "догнано ровно одно пропущенное событие",
    );
    resume.close();

    // 5. Реконнект без курсора реплеит всю ленту evt1..evt4 — всё дедуплицируется по event_id.
    const full = bff.connectRealtime({ subscription: { organizationId: ORGANIZATION_ID } });
    assert.equal(
      bff.backend.getMetrics().realtime_duplicate_total,
      4,
      "полный реплей полностью дедуплицирован по event_id",
    );
    assert.equal(
      bff.realtimeConsumer.getMetrics().realtime_message_created_total,
      4,
      "новых сообщений не добавилось",
    );
    full.close();

    // 6. Мобильный sync добивает ленту: 4 сообщения строго по порядку, без дублей и потерь.
    const synced = await getJson(baseUrl, syncPath(baseline.body.cursor));
    assert.deepEqual(
      synced.body.deltas.messages.map((message) => message.sequence_number),
      [1, 2, 3, 4],
    );
    assert.equal(
      new Set(synced.body.deltas.messages.map((message) => message.message_id)).size,
      4,
      "нет дублей после реплея и sync",
    );
  });
});
