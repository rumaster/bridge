import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createWebChatAdapter } from "../../src/adapters/web-chat/web-chat-adapter.mjs";
import { createIntegrationPlatformServer } from "../../src/server.mjs";

const JSON_HEADERS = { "content-type": "application/json" };

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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("web chat adapter M1", () => {
  const ingressCalls = [];
  let coreServer;
  let coreBaseUrl;
  let integrationServer;
  let integrationBaseUrl;
  let adapter;

  before(async () => {
    coreServer = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/internal/ingress/messages") {
        ingressCalls.push(await readJson(request));
        response.writeHead(202, JSON_HEADERS);
        response.end(JSON.stringify({ accepted: true, sequence: ingressCalls.length }));
        return;
      }

      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    coreBaseUrl = await listen(coreServer);

    adapter = createWebChatAdapter({
      coreIngressUrl: `${coreBaseUrl}/internal/ingress/messages`,
      now: () => "2026-07-03T09:00:00.000Z",
    });
    integrationServer = createIntegrationPlatformServer({ webChatAdapter: adapter });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("публикует возможности C6 Web Chat", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/capabilities`);

    assert.equal(response.status, 200);
    const capabilities = await response.json();
    assert.equal(capabilities.contract, "C6.CapabilityDescriptor");
    assert.equal(capabilities.channel_type, "web_chat");
    assert.equal(capabilities.capabilities.text.supported, true);
    assert.equal(capabilities.capabilities.typing_indicator.supported, true);
    assert.equal(capabilities.capabilities.read_receipt.supported, true);
  });

  it("нормализует входящее сообщение Web Chat в canonical C1 и публикует C2 Ingress", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        idempotency_key: "12345678-1234-4234-8234-123456789abc",
        organization_id: "22345678-1234-4234-8234-123456789abc",
        conversation_id: "32345678-1234-4234-8234-123456789abc",
        endpoint_id: "42345678-1234-4234-8234-123456789abc",
        visitor_session_id: "visitor-session-1",
        text: "Нужна помощь",
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.message_id, "12345678-1234-4234-8234-123456789abc");

    assert.equal(ingressCalls.length, 1);
    assert.deepEqual(ingressCalls[0], {
      id: "12345678-1234-4234-8234-123456789abc",
      idempotency_key: "12345678-1234-4234-8234-123456789abc",
      organization_id: "22345678-1234-4234-8234-123456789abc",
      conversation_id: "32345678-1234-4234-8234-123456789abc",
      endpoint_id: "42345678-1234-4234-8234-123456789abc",
      channel: "web_chat",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 1,
      type: "text",
      content: {
        text: "Нужна помощь",
      },
      status: "received",
      created_at: "2026-07-03T09:00:00.000Z",
      updated_at: "2026-07-03T09:00:00.000Z",
      metadata: {
        visitor_session_id: "visitor-session-1",
      },
    });
  });

  it("принимает C2 Egress ответа менеджера и сохраняет доставку в Web Chat канал", async () => {
    const response = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: "manager-reply-1",
        channel_id: "web-chat-channel",
        message: {
          message_id: "manager-reply-1",
          organization_id: "22345678-1234-4234-8234-123456789abc",
          channel_id: "web-chat-channel",
          channel_type: "web_chat",
          conversation_ref: "32345678-1234-4234-8234-123456789abc",
          direction: "outbound",
          content: { type: "text", text: "Здравствуйте, чем помочь?" },
          occurred_at: "2026-07-03T09:01:00.000Z",
        },
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.deepEqual(adapter.getChannelDeliveries(), [
      {
        idempotency_key: "manager-reply-1",
        message_id: "manager-reply-1",
        organization_id: "22345678-1234-4234-8234-123456789abc",
        conversation_ref: "32345678-1234-4234-8234-123456789abc",
        channel_id: "web-chat-channel",
        content: { type: "text", text: "Здравствуйте, чем помочь?" },
        accepted_at: "2026-07-03T09:00:00.000Z",
      },
    ]);
  });
});
