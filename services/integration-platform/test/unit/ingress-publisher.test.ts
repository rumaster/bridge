import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IngressPublishError,
  createIngressPublisher,
} from "../../src/inbound/ingress-publisher.js";
import { stableEdgeEndpointId, stableTelegramMessageId } from "../../src/inbound/ids.js";

const CORE = "http://core.test/internal/ingress/messages";
const EDGE = "http://edge.test/internal/edge/ingress/messages";
const ORG = "11111111-1111-1111-1111-111111111111";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ingress(channelId = "chan-A", updateId = 7) {
  const messageId = stableTelegramMessageId(channelId, updateId);
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: messageId,
    received_at: "2026-07-10T00:00:00.000Z",
    message: {
      message_id: messageId,
      idempotency_key: messageId,
      organization_id: ORG,
      channel_id: channelId,
      channel_type: "telegram",
      conversation_ref: "chat-1",
      sender_ref: "client-1",
      direction: "inbound",
      content: { type: "text", text: "hi" },
      occurred_at: "2026-07-10T00:00:00.000Z",
    },
  };
}

describe("ingress publisher (T5 core/edge routing)", () => {
  it("posts to core by default and reports edge unavailable without an edge URL", async () => {
    const calls: string[] = [];
    const publisher = createIngressPublisher({
      coreIngressUrl: CORE,
      fetchImpl: async (url: any) => {
        calls.push(String(url));
        return new Response("{}", { status: 202 });
      },
    });

    assert.equal(publisher.edgeAvailable(), false);
    const result = await publisher.publish(ingress(), { routeViaEdge: true });
    assert.equal(result.route, "core", "no edge URL → always core even if routeViaEdge");
    assert.deepEqual(calls, [CORE]);
  });

  it("routes RF traffic through the edge with a valid edge-ingest body", async () => {
    let edgeBody: any;
    const publisher = createIngressPublisher({
      coreIngressUrl: CORE,
      edgeIngressUrl: EDGE,
      fetchImpl: async (url: any, init: any) => {
        if (String(url) === EDGE) {
          edgeBody = JSON.parse(String(init.body));
        }
        return new Response("{}", { status: 202 });
      },
    });

    assert.equal(publisher.edgeAvailable(), true);
    const result = await publisher.publish(ingress("chan-A", 7), { routeViaEdge: true });
    assert.equal(result.route, "edge");

    // Edge требует UUID id/endpoint_id верхнего уровня; конверт C2 сохранён внутри.
    assert.equal(edgeBody.contract, "C2.IngressMessage");
    assert.equal(edgeBody.id, stableTelegramMessageId("chan-A", 7));
    assert.match(edgeBody.id, UUID_RE);
    assert.equal(edgeBody.endpoint_id, stableEdgeEndpointId("chan-A", "client-1"));
    assert.match(edgeBody.endpoint_id, UUID_RE);
    assert.equal(edgeBody.idempotency_key, edgeBody.message.message_id);
    assert.equal(edgeBody.message.channel_type, "telegram");
  });

  it("does not route via edge when routeViaEdge is false", async () => {
    const calls: string[] = [];
    const publisher = createIngressPublisher({
      coreIngressUrl: CORE,
      edgeIngressUrl: EDGE,
      fetchImpl: async (url: any) => {
        calls.push(String(url));
        return new Response("{}", { status: 202 });
      },
    });

    await publisher.publish(ingress(), { routeViaEdge: false });
    assert.deepEqual(calls, [CORE]);
  });

  it("throws a retryable IngressPublishError on non-2xx and on network failure", async () => {
    const rejecting = createIngressPublisher({
      coreIngressUrl: CORE,
      edgeIngressUrl: EDGE,
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    await assert.rejects(
      () => rejecting.publish(ingress(), { routeViaEdge: true }),
      (error: unknown) =>
        error instanceof IngressPublishError &&
        error.retryable === true &&
        error.route === "edge" &&
        error.status === 503,
    );

    const networkDown = createIngressPublisher({
      coreIngressUrl: CORE,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await assert.rejects(
      () => networkDown.publish(ingress()),
      (error: unknown) => error instanceof IngressPublishError && error.retryable === true,
    );
  });
});
