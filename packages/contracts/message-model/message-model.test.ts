import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MESSAGE_STATUS,
  assertMessageStatusTransition,
  validateCanonicalMessage,
} from "./index.js";

const validMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  idempotency_key: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  conversation_id: "33333333-3333-4333-8333-333333333333",
  endpoint_id: "44444444-4444-4444-8444-444444444444",
  channel: "web_chat",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 1,
  type: "text",
  content: {
    text: "Hello",
  },
  status: "received",
  created_at: "2026-07-02T16:00:00.000Z",
  updated_at: "2026-07-02T16:00:00.000Z",
};

describe("C1 Message Model", () => {
  it("accepts a valid canonical message DTO", () => {
    const result = validateCanonicalMessage(validMessage);

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("rejects a message without required tenant and idempotency fields", () => {
    const result = validateCanonicalMessage({
      ...validMessage,
      organization_id: undefined,
      idempotency_key: "55555555-5555-4555-8555-555555555555",
    });

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /organization_id/);
    assert.match(result.errors.join("\n"), /idempotency_key must match id/);
  });

  it("freezes the minimum received to routed to sent status flow", () => {
    assert.equal(assertMessageStatusTransition(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.ROUTED), true);
    assert.equal(assertMessageStatusTransition(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.SENT), true);
    assert.equal(assertMessageStatusTransition(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.SENT), false);
  });
});
