import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createWebChatAdapter } from "../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.mjs";
import { createIntegrationPlatformServer } from "../../services/integration-platform/src/server.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-03T09:00:00.000Z";

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

describe("CP-1 Web Chat: receive and reply", () => {
  const ingressMessages = [];
  let coreServer;
  let coreBaseUrl;
  let integrationServer;
  let integrationBaseUrl;
  let webChatAdapter;

  before(async () => {
    coreServer = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/internal/ingress/messages") {
        ingressMessages.push(await readJson(request));
        response.writeHead(202, JSON_HEADERS);
        response.end(JSON.stringify({ accepted: true }));
        return;
      }

      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    coreBaseUrl = await listen(coreServer);

    webChatAdapter = createWebChatAdapter({
      coreIngressUrl: `${coreBaseUrl}/internal/ingress/messages`,
      now: fixedNow,
    });
    integrationServer = createIntegrationPlatformServer({ webChatAdapter });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("accepts a Web Chat message, sends C2 Ingress to core, then delivers the reply", async () => {
    const incoming = await fetch(`${integrationBaseUrl}/web-chat/incoming/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
        channel_id: "channel-web",
        message_id: "web-in-1",
        session_id: "session-1",
        sender_ref: "visitor-1",
        text: "Нужна помощь",
      }),
    });

    assert.equal(incoming.status, 202);
    assert.equal(ingressMessages.length, 1);
    assert.equal(ingressMessages[0].idempotency_key, "web-in-1");
    assert.equal(ingressMessages[0].message.message_id, "web-in-1");
    assert.equal(ingressMessages[0].message.conversation_ref, "session-1");

    const reply = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
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
          content: {
            type: "text",
            text: "Здравствуйте, чем помочь?",
          },
        },
      }),
    });

    assert.equal(reply.status, 202);
    assert.deepEqual(webChatAdapter.getChannelDeliveries(), [
      {
        idempotency_key: "web-out-1",
        message_id: "web-out-1",
        organization_id: "org-1",
        channel_id: "channel-web",
        session_id: "session-1",
        type: "text",
        text: "Здравствуйте, чем помочь?",
        attachments: [],
        accepted_at: fixedNow(),
      },
    ]);
  });
});
