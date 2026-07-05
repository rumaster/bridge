import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../../../packages/contracts/src/c9.js";
import {
  BufferedEdgeGatewayValidationError,
  createBufferedEdgeGateway,
} from "../../src/buffered-gateway.js";

const ENDPOINT_ID = "42345678-1234-4234-8234-123456789abc";
const ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
const CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";

const MESSAGE_IDS = {
  1: "12345678-1234-4234-8234-123456789ab1",
  2: "12345678-1234-4234-8234-123456789ab2",
  3: "12345678-1234-4234-8234-123456789ab3",
};

function canonicalMessage({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "telegram",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `ping ${seq}` },
    status: "received",
    created_at: "2026-07-02T16:10:00.000Z",
    updated_at: "2026-07-02T16:10:00.000Z",
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonicalMessage({ id, seq }),
    receivedAt: "2026-07-02T16:10:01.000Z",
  });
}

describe("Буферизующий шлюз SVC-EDGE (CP-7)", () => {
  it("буферизует офлайн, дедуплицирует по idempotency_key и дренажирует одним батчем при переподключении", async () => {
    const forwarded = [];
    const gateway = createBufferedEdgeGateway({
      forward: async (messages) => {
        forwarded.push(messages);
        return { forwarded: messages.length };
      },
      now: () => "2026-07-02T16:11:00.000Z",
      connected: false,
    });

    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[3], seq: 3 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[2], seq: 2 }));
    await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 })); // повтор

    assert.equal(gateway.bufferedCount(), 3);
    assert.equal(forwarded.length, 0, "офлайн ничего не форвардит");

    const drain = await gateway.connect();
    assert.equal(drain.drained, 3);
    assert.equal(forwarded.length, 1, "дренаж отдаёт один батч");
    assert.equal(forwarded[0].length, 3);
    assert.equal(gateway.bufferedCount(), 0);

    const metrics = gateway.getMetrics();
    assert.equal(metrics.buffered_total, 3);
    assert.equal(metrics.drained_total, 3);
  });

  it("онлайн форвардит сообщение сразу, без буфера", async () => {
    const forwarded = [];
    const gateway = createBufferedEdgeGateway({
      forward: async (messages) => {
        forwarded.push(messages);
        return { forwarded: messages.length };
      },
      now: () => "2026-07-02T16:11:00.000Z",
      connected: true,
    });

    const outcome = await gateway.receive(tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 }));
    assert.equal(outcome.forwarded, true);
    assert.equal(outcome.buffered, false);
    assert.equal(gateway.bufferedCount(), 0);
    assert.equal(forwarded.length, 1);
    assert.equal(gateway.getMetrics().forwarded_online_total, 1);
  });

  it("отклоняет невалидное сообщение туннеля C9", async () => {
    const gateway = createBufferedEdgeGateway({
      forward: async () => ({}),
      connected: false,
    });

    const broken = tunnelMessage({ id: MESSAGE_IDS[1], seq: 1 });
    broken.sequence_number = 777; // рассинхрон с payload

    await assert.rejects(
      () => gateway.receive(broken),
      (error) => {
        assert.ok(error instanceof BufferedEdgeGatewayValidationError);
        return true;
      },
    );
    assert.equal(gateway.getMetrics().rejected_total, 1);
  });

  it("требует forward-колбэк", () => {
    assert.throws(() => createBufferedEdgeGateway({}), /forward/);
  });
});
