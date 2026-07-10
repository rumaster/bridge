import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultChannelAdapters,
  createTelegramForwardingChannelAdapter,
} from "../../src/channel-adapters.js";

const fixedNow = () => "2026-07-04T09:30:00.000Z";

function notification(overrides = {}) {
  return {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notification-1",
    organization_id: "org-1",
    recipient_user_id: "manager-1",
    category: "critical",
    title: "Новое сообщение",
    body: "Клиент ожидает ответа",
    payload: { conversation_id: "conv-1" },
    status: "new",
    channels: ["web", "telegram"],
    created_at: "2026-07-04T09:30:00.000Z",
    read_at: null,
    ...overrides,
  };
}

describe("telegram forwarding channel adapter (G-8)", () => {
  it("forwards the notification card to SVC-TGC and records the handoff", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const adapter = createTelegramForwardingChannelAdapter({
      url: "http://svc-tgc.test",
      now: fixedNow,
      fetchImpl: async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ status: "delivered" }), { status: 202 });
      },
    });

    const record: any = adapter.deliver({ notification: notification() });

    // Синхронный handoff-record.
    assert.equal(record.channel, "telegram");
    assert.equal(record.status, "sent");
    assert.equal(record.provider, "svc-tgc");
    assert.equal(record.provider_ref, "telegram:notification-1");
    assert.equal(record.forwarded_to, "http://svc-tgc.test");

    await adapter.drain();

    // Реальный POST в SVC-TGC.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://svc-tgc.test/internal/notifications/telegram");
    assert.equal(calls[0].body.notification.id, "notification-1");
    assert.equal(calls[0].body.notification.recipient_user_id, "manager-1");

    const results = adapter.getForwardResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);

    const dispatches = adapter.getDispatches();
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].notification_id, "notification-1");
  });

  it("does not throw on forward failure — delivery stays best-effort", async () => {
    const adapter = createTelegramForwardingChannelAdapter({
      url: "http://svc-tgc.test/",
      now: fixedNow,
      logger: { warn() {} },
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });

    const record: any = adapter.deliver({ notification: notification() });
    assert.equal(record.status, "sent");

    await adapter.drain();

    const results = adapter.getForwardResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /HTTP 503/);
  });

  it("createDefaultChannelAdapters wires forwarding telegram only when a URL is configured", () => {
    const withUrl: any = createDefaultChannelAdapters({
      now: fixedNow,
      telegramForwardUrl: "http://svc-tgc.test",
      fetchImpl: async () => new Response("{}", { status: 202 }),
    });
    assert.equal(typeof withUrl.telegram.drain, "function", "forwarding adapter exposes drain()");
    assert.equal(typeof withUrl.telegram.getForwardResults, "function");

    const withoutUrl: any = createDefaultChannelAdapters({ now: fixedNow, telegramForwardUrl: null });
    assert.equal(withoutUrl.telegram.drain, undefined, "recording mock has no drain()");
    assert.equal(withoutUrl.telegram.channel, "telegram");
  });
});
