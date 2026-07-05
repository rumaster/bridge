import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createInMemoryCoreDelivery } from "../../src/campaign/index.js";
import { createDeterministicBroadcastMock } from "../../src/deterministic-broadcast.js";
import { createBroadcastPlatformServer } from "../../src/server.js";

const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-04T13:00:00.000Z";

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

function startRequest(idempotencyKey) {
  return {
    contract: "C8.StartBroadcastRequest",
    version: "1.0.0",
    request_id: `req-${idempotencyKey}`,
    organization_id: "org-1",
    started_by: "manager-1",
    mode: "immediate",
    idempotency_key: idempotencyKey,
  };
}

describe("E2E CP-6 — Broadcast: доставка кампании через ядро", () => {
  let server;
  let baseUrl;
  let coreDelivery;

  before(async () => {
    coreDelivery = createInMemoryCoreDelivery();
    const broadcast = createDeterministicBroadcastMock({ now: fixedNow, core: coreDelivery });
    server = createBroadcastPlatformServer({ broadcast });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("запуск кампании доставляет через единый механизм ядра и собирает статистику", async () => {
    const response = await fetch(`${baseUrl}/api/v1/broadcasts/broadcast-1:start`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(startRequest("campaign-run-1")),
    });
    const body: any = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.broadcast.status, "done");
    // Каждый черновик — канонический C1 через C1/C2, sender_type=broadcast.
    for (const draft of body.core_delivery_drafts) {
      assert.equal(draft.sender_type, "broadcast");
      assert.equal(draft.delivery_path, "C1/C2");
    }
    // broadcast_stats собрана из статусов ядра.
    assert.equal(body.stats.prepared, 3);
    assert.equal(body.stats.sent, 3);
    assert.equal(body.stats.failed, 0);
    // Событие C7 broadcast.state_changed эмитировано (running -> done).
    assert.equal(body.state_changed_event.status, "done");

    // Доставка прошла через ядро: связи broadcast_messages <-> messages.
    assert.equal(coreDelivery.getBroadcastMessages().length, 3);
  });

  it("повторный запуск с тем же idempotency_key не создаёт дублей в ядре (§11.12)", async () => {
    const response = await fetch(`${baseUrl}/api/v1/broadcasts/broadcast-1:start`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(startRequest("campaign-run-1")),
    });
    const body: any = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.stats.sent, 3, "статистика повторного запуска консистентна");
    // Ключевой инвариант CP-6: ядро дедуплицирует — новых broadcast_messages нет.
    assert.equal(
      coreDelivery.getBroadcastMessages().length,
      3,
      "повторный запуск не создал дублей сообщений",
    );
  });

  it("stats-эндпоинт возвращает итоговую статистику кампании", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/broadcasts/broadcast-1/stats?organization_id=org-1`,
    );
    const body: any = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "done");
    assert.equal(body.stats.prepared, 3);
    assert.equal(body.stats.sent, 3);
    assert.equal(body.stats.delivered, 0);
    assert.equal(body.stats.failed, 0);
  });
});
