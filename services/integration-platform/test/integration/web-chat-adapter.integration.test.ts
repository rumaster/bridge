import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createWebChatAdapter } from "../../src/adapters/web-chat/web-chat-adapter.js";
import { createIntegrationPlatformServer } from "../../src/server.js";

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
  await new Promise<void>((resolve, reject) => {
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
    integrationServer = createIntegrationPlatformServer({
      webChatAdapter: adapter,
    });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("exposes C6 capabilities for Web Chat", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/capabilities`);

    assert.equal(response.status, 200);
    const capabilities: any = await response.json();
    assert.equal(capabilities.contract, "C6.CapabilityDescriptor");
    assert.equal(capabilities.channel_type, "web_chat");
    assert.equal(capabilities.capabilities.text.supported, true);
    // WG-14: вложения (image/file) не заявляются как supported.
    assert.equal(capabilities.capabilities.image.supported, false);
    assert.equal(capabilities.capabilities.file.supported, false);
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

  it("preserves the M1 Web Chat Endpoint route from SVC-CHAT", async () => {
    const previousCalls = ingressCalls.length;
    const response = await fetch(`${integrationBaseUrl}/web-chat/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
        conversation_id: "conversation-1",
        endpoint_id: "channel-web",
        visitor_session_id: "visitor-1",
        idempotency_key: "web-msg-legacy-1",
        body: {
          type: "text",
          text: "hello from widget",
        },
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(ingressCalls.length, previousCalls + 1);

    const ingress = ingressCalls.at(-1);
    assert.equal(ingress.contract, "C2.IngressMessage");
    assert.equal(ingress.idempotency_key, "web-msg-legacy-1");
    assert.equal(ingress.message.message_id, "web-msg-legacy-1");
    assert.equal(ingress.message.channel_id, "channel-web");
    assert.equal(ingress.message.conversation_ref, "conversation-1");
    assert.equal(ingress.message.sender_ref, "visitor-1");
    assert.deepEqual(ingress.message.content, {
      type: "text",
      text: "hello from widget",
    });
  });

  it("returns 400 for invalid Web Chat Endpoint payloads", async () => {
    const response = await fetch(`${integrationBaseUrl}/web-chat/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
      }),
    });

    assert.equal(response.status, 400);
    const body: any = await response.json();
    assert.equal(body.accepted, false);
    assert.match(body.errors[0], /channel_id or endpoint_id/);
  });

  it("не диспетчеризует Web Chat egress: доставка терминальна по C7/WS (WG-6, W1)", async () => {
    // Web Chat — inbound/C6-only: у адаптера нет acceptEgressDelivery, а в движок
    // доставки SVC-INT он не регистрируется. Исходящее доходит до посетителя
    // публикацией C7-события ядром, а не egress-конвертом сюда.
    assert.equal(typeof (adapter as any).acceptEgressDelivery, "undefined");
    assert.equal(typeof (adapter as any).getChannelDeliveries, "undefined");
  });
});
