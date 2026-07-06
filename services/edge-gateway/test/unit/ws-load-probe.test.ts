import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runMockWebSocketLoadProbe } from "../../src/ws-load-probe.js";

describe("SVC-EDGE M5 — WebSocket load probe", () => {
  it("измеряет поток подключений и событий без потерь и дублей в mock C7 gateway", () => {
    const result = runMockWebSocketLoadProbe({
      connections: 25,
      events: 8,
      organizationId: "org-load",
      conversationId: "conversation-load",
      now: () => "2026-07-04T19:00:00.000Z",
    });

    assert.equal(result.connections, 25);
    assert.equal(result.events, 8);
    assert.equal(result.delivered_total, 25 * 8);
    assert.equal(result.retained_events, 8);
    assert.equal(result.duplicate_event_total, 0);
    assert.ok(result.duration_ms >= 0);
    assert.ok(result.events_per_second >= 0);
    assert.ok(result.deliveries_per_second >= 0);
  });
});
