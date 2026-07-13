import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isC7RealtimeRequired } from "../../src/edge-runtime.js";

/**
 * Обязательность C7-realtime (Redis) на Edge (W3, WG-8). Fail-fast при отсутствии
 * REDIS_URL включается явным флагом ИЛИ автоматически при включённом транзите
 * Web Chat — иначе тихая деградация realtime. docs/plan/web-chat-channel-production.md.
 */
describe("isC7RealtimeRequired (W3)", () => {
  it("не требует realtime по умолчанию (edge только для MAX/email)", () => {
    assert.equal(isC7RealtimeRequired({}), false);
  });

  it("требует realtime при явном флаге EDGE_C7_REALTIME_REQUIRED", () => {
    assert.equal(isC7RealtimeRequired({ EDGE_C7_REALTIME_REQUIRED: "on" }), true);
    assert.equal(isC7RealtimeRequired({ EDGE_C7_REALTIME_REQUIRED: "1" }), true);
    assert.equal(isC7RealtimeRequired({ EDGE_C7_REALTIME_REQUIRED: "true" }), true);
    assert.equal(isC7RealtimeRequired({ EDGE_C7_REALTIME_REQUIRED: "off" }), false);
  });

  it("требует realtime автоматически при включённом транзите Web Chat", () => {
    assert.equal(
      isC7RealtimeRequired({ EDGE_WEB_CHAT_BACKEND_URL: "http://10.7.0.1:3000" }),
      true,
    );
    assert.equal(isC7RealtimeRequired({ EDGE_WEB_CHAT_BACKEND_URL: "  " }), false);
  });
});
