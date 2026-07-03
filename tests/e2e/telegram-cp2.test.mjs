import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createBackendServer } from "../../services/backend/src/main.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createCommunicationCoreModule,
} from "../../services/backend/src/modules/communication-core/index.mjs";
import { createTelegramAdapter } from "../../services/integration-platform/src/adapters/telegram/telegram-adapter.mjs";
import { createIntegrationPlatformServer } from "../../services/integration-platform/src/server.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const fixedNow = () => "2026-07-03T09:00:00.000Z";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const INBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000731";
const OUTBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000732";

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

describe("CP-2 Telegram: receive and reply", () => {
  let coreServer;
  let coreBaseUrl;
  let integrationServer;
  let integrationBaseUrl;
  let telegramAdapter;

  before(async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({
      store,
      clock: fixedNow,
      egressAdapter: {
        async deliver(delivery) {
          const response = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(delivery),
          });
          const body = await response.json();

          return {
            accepted: response.ok && body.accepted,
            duplicate: body.duplicate,
            status: response.ok ? "sent" : "failed",
            error: body.errors?.join("; "),
          };
        },
      },
    });
    coreServer = createBackendServer({
      modules: [createCommunicationCoreModule({ core })],
    });
    coreBaseUrl = await listen(coreServer);

    telegramAdapter = createTelegramAdapter({
      coreIngressUrl: `${coreBaseUrl}/api/v1/internal/ingress/messages`,
      now: fixedNow,
    });
    integrationServer = createIntegrationPlatformServer({
      adapters: {
        telegram: telegramAdapter,
      },
    });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("accepts a Telegram message, sends C2 Ingress to core, then delivers the reply", async () => {
    const incoming = await fetch(`${integrationBaseUrl}/telegram/incoming/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: ORGANIZATION_ID,
        channel_id: "channel-telegram",
        message_id: INBOUND_MESSAGE_ID,
        message: {
          message_id: 731,
          chat: { id: "telegram-chat-1" },
          from: { id: "telegram-user-1" },
          text: "Нужна помощь в Telegram",
        },
      }),
    });

    assert.equal(incoming.status, 202);
    const incomingBody = await incoming.json();
    assert.equal(incomingBody.accepted, true);
    assert.equal(incomingBody.ingress.idempotency_key, INBOUND_MESSAGE_ID);
    assert.equal(incomingBody.ingress.message.channel_type, "telegram");
    assert.equal(incomingBody.ingress.message.conversation_ref, "telegram-chat-1");

    const conversationsResponse = await fetch(`${coreBaseUrl}/api/v1/conversations`, {
      headers: {
        "x-organization-id": ORGANIZATION_ID,
      },
    });

    assert.equal(conversationsResponse.status, 200);
    const conversations = await conversationsResponse.json();
    assert.equal(conversations.data.length, 1);
    assert.equal(conversations.data[0].status, "open");

    const reply = await fetch(`${coreBaseUrl}/api/v1/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        idempotency_key: OUTBOUND_MESSAGE_ID,
        organization_id: ORGANIZATION_ID,
        conversation_id: conversations.data[0].id,
        sender_type: "manager",
        type: "text",
        content: {
          text: "Здравствуйте, отвечаем из ядра.",
        },
      }),
    });

    assert.equal(reply.status, 202);
    const replyBody = await reply.json();
    assert.equal(replyBody.status, "sent");
    assert.deepEqual(telegramAdapter.getChannelDeliveries(), [
      {
        idempotency_key: OUTBOUND_MESSAGE_ID,
        message_id: OUTBOUND_MESSAGE_ID,
        organization_id: ORGANIZATION_ID,
        channel_id: "channel-telegram",
        channel_type: "telegram",
        conversation_ref: "telegram-chat-1",
        recipient_ref: "telegram-chat-1",
        type: "text",
        text: "Здравствуйте, отвечаем из ядра.",
        attachments: [],
        external_payload: {
          method: "sendMessage",
          chat_id: "telegram-chat-1",
          text: "Здравствуйте, отвечаем из ядра.",
          idempotency_key: OUTBOUND_MESSAGE_ID,
        },
        accepted_at: fixedNow(),
      },
    ]);
  });
});
