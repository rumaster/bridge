import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCommunicationCoreMock } from "../../src/modules/communication-core/mock-ingress-egress.mjs";

const inboundMessage = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  endpoint_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  channel: "web_chat",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 7,
  type: "text",
  content: {
    text: "Need help",
  },
  status: "received",
  created_at: "2026-07-02T16:05:00.000Z",
  updated_at: "2026-07-02T16:05:00.000Z",
};

describe("Communication Core M0 mock", () => {
  it("accepts a valid C2 ingress message without persisting it to a database", () => {
    const core = createCommunicationCoreMock();
    const response = core.acceptIngressMessage(inboundMessage);

    assert.equal(response.accepted, true);
    assert.equal(response.mock, true);
    assert.equal(response.message_id, inboundMessage.id);
    assert.equal(response.idempotency_key, inboundMessage.idempotency_key);
    assert.equal(response.conversation_id, inboundMessage.conversation_id);
    assert.equal(response.sequence_number, inboundMessage.sequence_number);
    assert.equal(response.status, "received");
  });

  it("rejects invalid C2 ingress DTOs", () => {
    const core = createCommunicationCoreMock();

    assert.throws(
      () => core.acceptIngressMessage({ ...inboundMessage, endpoint_id: "" }),
      /endpoint_id/,
    );
  });

  it("marks repeated ingress with the same idempotency key as a duplicate", () => {
    const core = createCommunicationCoreMock({
      clock: () => "2026-07-02T16:05:01.000Z",
    });

    const firstResponse = core.acceptIngressMessage(inboundMessage);
    const duplicateResponse = core.acceptIngressMessage(inboundMessage);

    assert.equal(firstResponse.duplicate, false);
    assert.equal(duplicateResponse.duplicate, true);
    assert.equal(duplicateResponse.message_id, firstResponse.message_id);
    assert.equal(core.getIngressAcceptances().length, 1);
  });

  it("records an egress handoff as a mock delivery without calling an adapter", () => {
    const core = createCommunicationCoreMock();
    const routedOutboundMessage = {
      ...inboundMessage,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      idempotency_key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      direction: "outbound",
      sender_type: "manager",
      status: "routed",
    };

    const response = core.handoffEgressMessage(routedOutboundMessage, {
      adapter: "web-chat",
      adapter_endpoint_id: "web-chat-adapter-local",
    });

    assert.equal(response.accepted, true);
    assert.equal(response.mock_delivery, true);
    assert.equal(response.message_id, routedOutboundMessage.id);
    assert.equal(response.delivery_status, "sent");
    assert.deepEqual(core.getEgressHandoffs(), [response]);
  });
});
