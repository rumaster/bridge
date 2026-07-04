import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  C7_EVENT_TYPES,
  createWebSocketEvent,
  validateWebSocketEvent,
} from "../../packages/contracts/src/c7.mjs";
import {
  createEdgeTunnelMessage,
} from "../../packages/contracts/src/c9.mjs";

const root = process.cwd();

const canonicalMessage = Object.freeze({
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  conversation_id: "32345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  channel: "telegram",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 42,
  type: "text",
  content: {
    text: "ping",
  },
  status: "received",
  created_at: "2026-07-02T16:10:00.000Z",
  updated_at: "2026-07-02T16:10:00.000Z",
});

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("EDGE <-> CORE M0 C9/C7 contract smoke", () => {
  it("publishes the C9 tunnel OpenAPI contract and C7 WebSocket OpenAPI contract", () => {
    const c9OpenApi = readJson("packages/contracts/openapi/edge/c9.edge-tunnel.openapi.json");
    const c7OpenApi = readJson("packages/contracts/openapi/edge/c7.websocket.openapi.json");

    assert.equal(c9OpenApi["x-contract-id"], "C9");
    assert.equal(c9OpenApi["x-owner"], "SVC-EDGE");
    assert.ok(c9OpenApi.paths["/internal/edge/tunnel/messages"].post);
    assert.equal(c7OpenApi["x-contract-id"], "C7");
    assert.equal(c7OpenApi.paths["/ws"].get["x-upgrade"], "websocket");
  });

  it("creates a valid C9 envelope without losing ordering keys", () => {
    const tunnelMessage = createEdgeTunnelMessage({
      payload: canonicalMessage,
      receivedAt: "2026-07-02T16:10:01.000Z",
      bufferedAt: "2026-07-02T16:10:02.000Z",
      forwardedAt: "2026-07-02T16:10:03.000Z",
    });

    assert.equal(tunnelMessage.endpoint_id, canonicalMessage.endpoint_id);
    assert.equal(tunnelMessage.sequence_number, canonicalMessage.sequence_number);
    assert.equal(tunnelMessage.idempotency_key, canonicalMessage.idempotency_key);
  });

  it("freezes every C7 event name in the common WebSocket event schema", () => {
    for (const [index, event] of C7_EVENT_TYPES.entries()) {
      const wsEvent = createWebSocketEvent({
        eventId: `event-${index + 1}`,
        organizationId: "org-1",
        event,
        sequenceNumber: index + 1,
        payload: {
          event,
        },
        occurredAt: "2026-07-02T16:20:00.000Z",
      });

      const validation = validateWebSocketEvent(wsEvent);

      assert.equal(validation.valid, true, validation.errors.join("\n"));
    }
  });
});
