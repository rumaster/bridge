import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createBroadcastPlatformServer } from "../../src/server.js";

const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-02T16:30:00.000Z";

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

describe("Broadcast Platform C8 deterministic mock server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createBroadcastPlatformServer({ now: fixedNow });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("starts and exposes health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "broadcast-platform",
      mode: "deterministic-mock",
      contract: "C8",
    });
  });

  it("lists deterministic seed broadcasts", async () => {
    const response = await fetch(`${baseUrl}/api/v1/broadcasts?organization_id=org-1`);
    const body: any = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.contract, "C8.ListBroadcastsResponse");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, "draft");
  });

  it("creates deterministic campaign responses", async () => {
    const payload = {
      contract: "C8.CreateBroadcastRequest",
      version: "1.0.0",
      request_id: "req-broadcast-create-1",
      organization_id: "org-1",
      created_by: "manager-1",
      name: "Июльская рассылка",
      template: {
        type: "text",
        body: "Здравствуйте, {{client.name}}",
      },
      filter: {
        mode: "all",
      },
      schedule: {
        mode: "manual",
      },
      rate_limit: {
        messages_per_minute: 120,
      },
    };

    const first = await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const second = await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(await first.json(), await second.json());
  });

  it("starts a broadcast and returns deterministic stats", async () => {
    const startResponse = await fetch(`${baseUrl}/api/v1/broadcasts/broadcast-1:start`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C8.StartBroadcastRequest",
        version: "1.0.0",
        request_id: "req-broadcast-start-1",
        organization_id: "org-1",
        started_by: "manager-1",
        mode: "immediate",
      }),
    });
    const started: any = await startResponse.json();

    assert.equal(startResponse.status, 200);
    assert.equal(started.contract, "C8.StartBroadcastResponse");
    // Кампания доставлена синхронно через единый механизм ядра (CP-6) — статус done.
    assert.equal(started.broadcast.status, "done");
    assert.equal(started.core_delivery_draft.sender_type, "broadcast");
    assert.equal(started.core_delivery_draft.delivery_path, "C1/C2");
    // Все получатели сегмента сформированы в отдельные C1-черновики.
    assert.equal(started.core_delivery_drafts.length, 3);
    // События C7 broadcast.state_changed на переходах running -> done.
    assert.equal(started.state_changed_events.length, 2);
    assert.equal(started.state_changed_events[0].status, "running");
    assert.equal(started.state_changed_events[1].status, "done");

    const statsResponse = await fetch(
      `${baseUrl}/api/v1/broadcasts/broadcast-1/stats?organization_id=org-1`,
    );
    const stats: any = await statsResponse.json();

    assert.equal(statsResponse.status, 200);
    assert.equal(stats.contract, "C8.BroadcastStatsResponse");
    assert.equal(stats.broadcast_id, "broadcast-1");
    assert.equal(stats.status, "done");
    assert.equal(stats.stats.prepared, 3);
    assert.equal(stats.stats.sent, 3);
    assert.equal(stats.stats.failed, 0);
  });
});
