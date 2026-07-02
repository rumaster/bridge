import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C9_CONTRACT,
  C9_VERSION,
  createEdgeTunnelMessage,
  validateEdgeTunnelMessage,
} from "../../src/c9.mjs";

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

describe("C9 Edge/App tunnel message DTO", () => {
  it("freezes sequence_number, idempotency_key, endpoint_id, payload and timestamps", () => {
    const tunnelMessage = createEdgeTunnelMessage({
      payload: canonicalMessage,
      receivedAt: "2026-07-02T16:10:01.000Z",
      bufferedAt: "2026-07-02T16:10:02.000Z",
      forwardedAt: "2026-07-02T16:10:03.000Z",
    });

    assert.equal(tunnelMessage.contract, C9_CONTRACT);
    assert.equal(tunnelMessage.version, C9_VERSION);
    assert.equal(tunnelMessage.endpoint_id, canonicalMessage.endpoint_id);
    assert.equal(tunnelMessage.sequence_number, canonicalMessage.sequence_number);
    assert.equal(tunnelMessage.idempotency_key, canonicalMessage.idempotency_key);
    assert.deepEqual(tunnelMessage.payload, canonicalMessage);
    assert.deepEqual(tunnelMessage.timestamps, {
      received_at: "2026-07-02T16:10:01.000Z",
      buffered_at: "2026-07-02T16:10:02.000Z",
      forwarded_at: "2026-07-02T16:10:03.000Z",
    });

    const validation = validateEdgeTunnelMessage(tunnelMessage);
    assert.equal(validation.valid, true);
  });

  it("rejects sequence drift between the C9 envelope and C1 payload", () => {
    const tunnelMessage = createEdgeTunnelMessage({
      payload: canonicalMessage,
      receivedAt: "2026-07-02T16:10:01.000Z",
      bufferedAt: "2026-07-02T16:10:02.000Z",
      forwardedAt: "2026-07-02T16:10:03.000Z",
    });

    const validation = validateEdgeTunnelMessage({
      ...tunnelMessage,
      sequence_number: tunnelMessage.sequence_number + 1,
    });

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /payload\.sequence_number/);
  });

  it("rejects idempotency drift between the C9 envelope and C1 payload", () => {
    const tunnelMessage = createEdgeTunnelMessage({
      payload: canonicalMessage,
      receivedAt: "2026-07-02T16:10:01.000Z",
      bufferedAt: "2026-07-02T16:10:02.000Z",
      forwardedAt: "2026-07-02T16:10:03.000Z",
    });

    const validation = validateEdgeTunnelMessage({
      ...tunnelMessage,
      idempotency_key: "52345678-1234-4234-8234-123456789abc",
    });

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /payload\.idempotency_key/);
  });
});
