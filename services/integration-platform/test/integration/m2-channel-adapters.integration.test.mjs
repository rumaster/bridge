import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createEmailAdapter } from "../../src/adapters/email/email-adapter.mjs";
import { createMaxAdapter } from "../../src/adapters/max/max-adapter.mjs";
import { createSmsAdapter } from "../../src/adapters/sms/sms-adapter.mjs";
import { createTelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.mjs";
import { createVkAdapter } from "../../src/adapters/vk/vk-adapter.mjs";
import { createWhatsAppAdapter } from "../../src/adapters/whatsapp/whatsapp-adapter.mjs";
import { createIntegrationPlatformServer } from "../../src/server.mjs";

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

describe("M2 channel adapters <-> mock core slice", () => {
  const ingressCalls = [];
  let coreServer;
  let coreBaseUrl;
  let integrationServer;
  let integrationBaseUrl;
  let adapters;

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

    const adapterOptions = {
      coreIngressUrl: `${coreBaseUrl}/internal/ingress/messages`,
      now: fixedNow,
    };
    adapters = {
      telegram: createTelegramAdapter(adapterOptions),
      email: createEmailAdapter(adapterOptions),
      sms: createSmsAdapter(adapterOptions),
      vk: createVkAdapter(adapterOptions),
      max: createMaxAdapter(adapterOptions),
      whatsapp: createWhatsAppAdapter(adapterOptions),
    };
    integrationServer = createIntegrationPlatformServer({ adapters });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("exposes C6 capabilities for all M2 channels", async () => {
    for (const channelType of Object.keys(adapters)) {
      const response = await fetch(`${integrationBaseUrl}/${channelType}/capabilities`);

      assert.equal(response.status, 200, channelType);
      const capabilities = await response.json();
      assert.equal(capabilities.contract, "C6.CapabilityDescriptor");
      assert.equal(capabilities.channel_type, channelType);
      assert.equal(capabilities.capabilities.text.supported, true);
    }
  });

  it("receives Telegram input and publishes C2 Ingress to core", async () => {
    const response = await fetch(`${integrationBaseUrl}/telegram/incoming/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
        channel_id: "channel-telegram",
        message_id: "telegram-http-in-1",
        message: {
          message_id: 901,
          chat: { id: "telegram-chat-1" },
          from: { id: "telegram-user-1" },
          text: "hello from telegram",
        },
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(ingressCalls.at(-1).contract, "C2.IngressMessage");
    assert.equal(ingressCalls.at(-1).idempotency_key, "telegram-http-in-1");
    assert.equal(ingressCalls.at(-1).message.channel_type, "telegram");
    assert.equal(ingressCalls.at(-1).message.content.text, "hello from telegram");
  });

  it("delivers C2 Egress to the matching channel adapter only once per idempotency key", async () => {
    const egressBody = {
      contract: "C2.EgressDelivery",
      version: "1.0.0",
      idempotency_key: "telegram-http-out-1",
      channel_id: "channel-telegram",
      message: {
        message_id: "telegram-http-out-1",
        organization_id: "org-1",
        channel_id: "channel-telegram",
        channel_type: "telegram",
        conversation_ref: "telegram-chat-1",
        direction: "outbound",
        content: { type: "text", text: "hello telegram" },
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

    assert.equal(adapters.telegram.getChannelDeliveries().length, 1);
    assert.equal(adapters.email.getChannelDeliveries().length, 0);
  });
});
