import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createBackendServer } from "../../services/backend/src/main.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createCommunicationCoreModule,
} from "../../services/backend/src/modules/communication-core/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const INBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000611";
const OUTBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000612";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("INT <-> CORE M1 contract", () => {
  const deliveries = [];
  let server;
  let baseUrl;

  before(async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({
      store,
      clock: () => "2026-07-03T10:05:00.000Z",
      egressAdapter: {
        async deliver(delivery) {
          deliveries.push(delivery);
          return { accepted: true, duplicate: false, status: "sent" };
        },
      },
    });

    server = createBackendServer({
      modules: [createCommunicationCoreModule({ core })],
    });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("замыкает C2 ingress -> conversations/messages -> C2 egress delivery", async () => {
    const ingressResponse = await fetch(`${baseUrl}/api/v1/internal/ingress/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract: "C2.IngressMessage",
        version: "1.0.0",
        idempotency_key: INBOUND_MESSAGE_ID,
        received_at: "2026-07-03T10:04:59.000Z",
        message: {
          message_id: INBOUND_MESSAGE_ID,
          organization_id: ORGANIZATION_ID,
          channel_id: "web-chat-channel",
          channel_type: "web_chat",
          external_message_id: "external-1",
          conversation_ref: "room-1",
          sender_ref: "visitor-1",
          direction: "inbound",
          content: { type: "text", text: "hello core" },
          occurred_at: "2026-07-03T10:04:59.000Z",
        },
      }),
    });

    assert.equal(ingressResponse.status, 202);
    const ingressBody = await ingressResponse.json();
    assert.equal(ingressBody.status, "routed");

    const conversationsResponse = await fetch(`${baseUrl}/api/v1/conversations`, {
      headers: {
        "x-organization-id": ORGANIZATION_ID,
      },
    });
    assert.equal(conversationsResponse.status, 200);
    const conversations = await conversationsResponse.json();
    assert.equal(conversations.data.length, 1);
    assert.equal(conversations.data[0].id, ingressBody.conversation_id);

    const outboundResponse = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: OUTBOUND_MESSAGE_ID,
        organization_id: ORGANIZATION_ID,
        conversation_id: ingressBody.conversation_id,
        sender_type: "manager",
        type: "text",
        content: { text: "manager reply" },
      }),
    });

    assert.equal(outboundResponse.status, 202);
    const outbound = await outboundResponse.json();
    assert.equal(outbound.status, "sent");
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0], {
      contract: "C2.EgressDelivery",
      version: "1.0.0",
      idempotency_key: OUTBOUND_MESSAGE_ID,
      channel_id: "web-chat-channel",
      message: {
        message_id: OUTBOUND_MESSAGE_ID,
        organization_id: ORGANIZATION_ID,
        channel_id: "web-chat-channel",
        channel_type: "web_chat",
        conversation_ref: "room-1",
        direction: "outbound",
        content: { type: "text", text: "manager reply" },
      },
    });
  });
});
