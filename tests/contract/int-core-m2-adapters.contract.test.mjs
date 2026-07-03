import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C6_CAPABILITIES,
  validateCapabilityDescriptor,
} from "../../packages/contracts/src/c6.mjs";
import { createEmailAdapter } from "../../services/integration-platform/src/adapters/email/email-adapter.mjs";
import { createMaxAdapter } from "../../services/integration-platform/src/adapters/max/max-adapter.mjs";
import { createSmsAdapter } from "../../services/integration-platform/src/adapters/sms/sms-adapter.mjs";
import { createTelegramAdapter } from "../../services/integration-platform/src/adapters/telegram/telegram-adapter.mjs";
import { createVkAdapter } from "../../services/integration-platform/src/adapters/vk/vk-adapter.mjs";
import { createWhatsAppAdapter } from "../../services/integration-platform/src/adapters/whatsapp/whatsapp-adapter.mjs";

const fixedNow = () => "2026-07-03T09:00:00.000Z";

const adapterCases = [
  {
    type: "telegram",
    createAdapter: createTelegramAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-telegram",
      message_id: "telegram-contract-in-1",
      message: {
        message_id: 101,
        chat: { id: "telegram-chat-1" },
        from: { id: "telegram-user-1" },
        text: "telegram contract",
      },
    },
  },
  {
    type: "email",
    createAdapter: createEmailAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-email",
      message_id: "email-contract-in-1",
      email: {
        from: "client@example.test",
        text: "email contract",
      },
    },
  },
  {
    type: "sms",
    createAdapter: createSmsAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-sms",
      message_id: "sms-contract-in-1",
      sms: {
        from: "+15550001001",
        text: "sms contract",
      },
    },
  },
  {
    type: "vk",
    createAdapter: createVkAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-vk",
      message_id: "vk-contract-in-1",
      object: {
        message: {
          id: 101,
          peer_id: "vk-peer-1",
          from_id: "vk-user-1",
          text: "vk contract",
        },
      },
    },
  },
  {
    type: "max",
    createAdapter: createMaxAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-max",
      message_id: "max-contract-in-1",
      message: {
        id: "max-message-1",
        chat_id: "max-chat-1",
        sender: { user_id: "max-user-1" },
        body: { text: "max contract" },
      },
    },
  },
  {
    type: "whatsapp",
    createAdapter: createWhatsAppAdapter,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-whatsapp",
      message_id: "whatsapp-contract-in-1",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wa-provider-1",
                    from: "+15550001002",
                    text: { body: "whatsapp contract" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  },
];

describe("INT <-> CORE M2 per-adapter contracts", () => {
  for (const adapterCase of adapterCases) {
    it(`${adapterCase.type} provides valid C6 and consumes C2 Ingress`, async () => {
      const calls = [];
      const adapter = adapterCase.createAdapter({
        coreIngressUrl: "http://core.local/internal/ingress/messages",
        fetchImpl: async (url, init) => {
          calls.push({
            body: JSON.parse(init.body),
            method: init.method,
            url,
          });

          return new Response(JSON.stringify({ accepted: true }), { status: 202 });
        },
        now: fixedNow,
      });

      const validation = validateCapabilityDescriptor(adapter.capabilityDescriptor);
      assert.equal(validation.valid, true, validation.errors.join("; "));
      assert.deepEqual(Object.keys(adapter.capabilityDescriptor.capabilities), C6_CAPABILITIES);

      const result = await adapter.publishIncomingMessage(adapterCase.inbound);

      assert.equal(result.accepted, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://core.local/internal/ingress/messages");
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body.contract, "C2.IngressMessage");
      assert.equal(calls[0].body.version, "1.0.0");
      assert.equal(calls[0].body.idempotency_key, adapterCase.inbound.message_id);
      assert.equal(calls[0].body.message.message_id, adapterCase.inbound.message_id);
      assert.equal(calls[0].body.message.idempotency_key, adapterCase.inbound.message_id);
      assert.equal(calls[0].body.message.channel_type, adapterCase.type);
      assert.equal(calls[0].body.message.direction, "inbound");
    });
  }
});
