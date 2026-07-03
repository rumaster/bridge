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

describe("Web Chat adapter <-> mock core CP-1 slice", () => {
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
        response.end(JSON.stringify({ accepted: true }));
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

  it("exposes C6 capabilities for Web Chat", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/capabilities`);

    assert.equal(response.status, 200);
    const capabilities = await response.json();
    assert.equal(capabilities.contract, "C6.CapabilityDescriptor");
    assert.equal(capabilities.channel_type, "web_chat");
    assert.equal(capabilities.capabilities.text.supported, true);
    assert.equal(capabilities.capabilities.image.supported, true);
    assert.equal(capabilities.capabilities.file.supported, true);
    assert.equal(capabilities.capabilities.typing_indicator.supported, true);
    assert.equal(capabilities.capabilities.read_receipt.supported, true);
    assert.equal(capabilities.capabilities.voice.supported, false);
  });

  it("receives Web Chat input and publishes C2 Ingress to core", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/incoming/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
        channel_id: "channel-web",
        message_id: "web-msg-1",
        session_id: "session-1",
        sender_ref: "visitor-1",
        text: "hello core",
        attachments: [
          {
            id: "image-1",
            kind: "image",
            storage_ref: "blob://image-1",
            mime: "image/png",
            size: 512,
          },
        ],
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(ingressCalls.length, 1);
    assert.equal(ingressCalls[0].contract, "C2.IngressMessage");
    assert.equal(ingressCalls[0].idempotency_key, "web-msg-1");
    assert.equal(ingressCalls[0].message.message_id, "web-msg-1");
    assert.equal(ingressCalls[0].message.channel_type, "web_chat");
    assert.equal(ingressCalls[0].message.content.text, "hello core");
    assert.equal(ingressCalls[0].message.attachments[0].kind, "image");
  });

  it("accepts C2 Egress and delivers one idempotent Web Chat payload", async () => {
    const egressBody = {
      contract: "C2.EgressDelivery",
      version: "1.0.0",
      idempotency_key: "web-out-1",
      channel_id: "channel-web",
      message: {
        message_id: "web-out-1",
        organization_id: "org-1",
        channel_id: "channel-web",
        channel_type: "web_chat",
        conversation_ref: "session-1",
        direction: "outbound",
        content: { type: "text", text: "hello web chat" },
      },
    };

    const first = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(egressBody),
    });
    const second = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(egressBody),
    });

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);

    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.accepted, true);
    assert.equal(firstBody.duplicate, false);
    assert.equal(secondBody.accepted, true);
    assert.equal(secondBody.duplicate, true);

    assert.deepEqual(adapter.getChannelDeliveries(), [
      {
        idempotency_key: "web-out-1",
        message_id: "web-out-1",
        organization_id: "org-1",
        channel_id: "channel-web",
        session_id: "session-1",
        type: "text",
        text: "hello web chat",
        attachments: [],
        accepted_at: "2026-07-03T09:00:00.000Z",
      },
    ]);
  });
});
