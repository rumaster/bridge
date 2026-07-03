import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TELEGRAM_CHANNEL_TYPE,
  createTelegramAdapter,
  normalizeIncomingTelegramMessage,
  normalizeOutgoingTelegramDelivery,
} from "../../src/adapters/telegram/telegram-adapter.mjs";
import {
  EMAIL_CHANNEL_TYPE,
  createEmailAdapter,
  normalizeIncomingEmailMessage,
  normalizeOutgoingEmailDelivery,
} from "../../src/adapters/email/email-adapter.mjs";
import {
  SMS_CHANNEL_TYPE,
  createSmsAdapter,
  normalizeIncomingSmsMessage,
  normalizeOutgoingSmsDelivery,
} from "../../src/adapters/sms/sms-adapter.mjs";
import {
  VK_CHANNEL_TYPE,
  createVkAdapter,
  normalizeIncomingVkMessage,
  normalizeOutgoingVkDelivery,
} from "../../src/adapters/vk/vk-adapter.mjs";
import {
  MAX_CHANNEL_TYPE,
  createMaxAdapter,
  normalizeIncomingMaxMessage,
  normalizeOutgoingMaxDelivery,
} from "../../src/adapters/max/max-adapter.mjs";
import {
  WHATSAPP_CHANNEL_TYPE,
  createWhatsAppAdapter,
  normalizeIncomingWhatsAppMessage,
  normalizeOutgoingWhatsAppDelivery,
} from "../../src/adapters/whatsapp/whatsapp-adapter.mjs";

const fixedNow = () => "2026-07-03T09:00:00.000Z";

const adapterCases = [
  {
    name: "Telegram",
    type: TELEGRAM_CHANNEL_TYPE,
    createAdapter: createTelegramAdapter,
    normalizeIncoming: normalizeIncomingTelegramMessage,
    normalizeOutgoing: normalizeOutgoingTelegramDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-telegram",
      message_id: "telegram-in-1",
      update_id: 1001,
      message: {
        message_id: 501,
        chat: { id: "chat-telegram-1" },
        from: { id: "user-telegram-1" },
        text: "telegram ping",
        photo: [
          {
            file_id: "tg-photo-file",
            file_unique_id: "tg-photo-unique",
            file_size: 4096,
          },
        ],
      },
    },
    expected: {
      channelId: "channel-telegram",
      conversationRef: "chat-telegram-1",
      senderRef: "user-telegram-1",
      text: "telegram ping",
      attachmentKind: "image",
      supported: ["text", "image", "file", "voice", "video", "buttons", "typing_indicator", "delete", "edit"],
      unsupported: ["read_receipt"],
    },
  },
  {
    name: "Email",
    type: EMAIL_CHANNEL_TYPE,
    createAdapter: createEmailAdapter,
    normalizeIncoming: normalizeIncomingEmailMessage,
    normalizeOutgoing: normalizeOutgoingEmailDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-email",
      message_id: "email-in-1",
      email: {
        message_id: "<email-in-1@example.test>",
        from: "client@example.test",
        subject: "Вопрос",
        text: "email ping",
        attachments: [
          {
            content_id: "email-file-1",
            filename: "invoice.pdf",
            mime: "application/pdf",
            size: 8192,
            storage_ref: "email://mailbox/email-file-1",
          },
        ],
      },
    },
    expected: {
      channelId: "channel-email",
      conversationRef: "client@example.test",
      senderRef: "client@example.test",
      text: "email ping",
      attachmentKind: "file",
      supported: ["text", "image", "file"],
      unsupported: ["typing_indicator", "read_receipt", "buttons"],
    },
  },
  {
    name: "SMS",
    type: SMS_CHANNEL_TYPE,
    createAdapter: createSmsAdapter,
    normalizeIncoming: normalizeIncomingSmsMessage,
    normalizeOutgoing: normalizeOutgoingSmsDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-sms",
      message_id: "sms-in-1",
      sms: {
        id: "sms-provider-1",
        from: "+15550001001",
        text: "sms ping",
      },
    },
    expected: {
      channelId: "channel-sms",
      conversationRef: "+15550001001",
      senderRef: "+15550001001",
      text: "sms ping",
      supported: ["text"],
      unsupported: ["image", "file", "typing_indicator", "read_receipt"],
    },
  },
  {
    name: "VK",
    type: VK_CHANNEL_TYPE,
    createAdapter: createVkAdapter,
    normalizeIncoming: normalizeIncomingVkMessage,
    normalizeOutgoing: normalizeOutgoingVkDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-vk",
      message_id: "vk-in-1",
      object: {
        message: {
          id: 701,
          peer_id: "vk-peer-1",
          from_id: "vk-user-1",
          text: "vk ping",
          attachments: [
            {
              type: "photo",
              photo: {
                id: "vk-photo-1",
                owner_id: "vk-owner-1",
                sizes: [{ type: "x", url: "https://vk.example/photo.jpg" }],
              },
            },
          ],
        },
      },
    },
    expected: {
      channelId: "channel-vk",
      conversationRef: "vk-peer-1",
      senderRef: "vk-user-1",
      text: "vk ping",
      attachmentKind: "image",
      supported: ["text", "image", "file", "voice", "video", "buttons", "typing_indicator"],
      unsupported: ["read_receipt", "delete", "edit"],
    },
  },
  {
    name: "MAX",
    type: MAX_CHANNEL_TYPE,
    createAdapter: createMaxAdapter,
    normalizeIncoming: normalizeIncomingMaxMessage,
    normalizeOutgoing: normalizeOutgoingMaxDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-max",
      message_id: "max-in-1",
      message: {
        id: "max-provider-1",
        chat_id: "max-chat-1",
        sender: { user_id: "max-user-1" },
        body: { text: "max ping" },
        attachments: [
          {
            id: "max-video-1",
            type: "video",
            url: "https://max.example/video.mp4",
            mime_type: "video/mp4",
            size: 16384,
          },
        ],
      },
    },
    expected: {
      channelId: "channel-max",
      conversationRef: "max-chat-1",
      senderRef: "max-user-1",
      text: "max ping",
      attachmentKind: "video",
      supported: ["text", "image", "file", "voice", "video", "buttons", "typing_indicator"],
      unsupported: ["read_receipt", "delete", "edit"],
    },
  },
  {
    name: "WhatsApp",
    type: WHATSAPP_CHANNEL_TYPE,
    createAdapter: createWhatsAppAdapter,
    normalizeIncoming: normalizeIncomingWhatsAppMessage,
    normalizeOutgoing: normalizeOutgoingWhatsAppDelivery,
    inbound: {
      organization_id: "org-1",
      channel_id: "channel-whatsapp",
      message_id: "whatsapp-in-1",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wa-provider-1",
                    from: "+15550001002",
                    text: { body: "whatsapp ping" },
                    image: { id: "wa-image-1", mime_type: "image/jpeg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    expected: {
      channelId: "channel-whatsapp",
      conversationRef: "+15550001002",
      senderRef: "+15550001002",
      text: "whatsapp ping",
      attachmentKind: "image",
      supported: ["text", "image", "file", "voice", "video", "buttons", "read_receipt"],
      unsupported: ["typing_indicator", "delete", "edit"],
    },
  },
];

describe("M2 channel adapter normalization", () => {
  for (const adapterCase of adapterCases) {
    it(`normalizes inbound ${adapterCase.name} payloads into C1`, () => {
      const message = adapterCase.normalizeIncoming(adapterCase.inbound, fixedNow);

      assert.equal(message.message_id, adapterCase.inbound.message_id);
      assert.equal(message.idempotency_key, adapterCase.inbound.message_id);
      assert.equal(message.channel_type, adapterCase.type);
      assert.equal(message.channel_id, adapterCase.expected.channelId);
      assert.equal(message.conversation_ref, adapterCase.expected.conversationRef);
      assert.equal(message.sender_ref, adapterCase.expected.senderRef);
      assert.equal(message.direction, "inbound");
      assert.deepEqual(message.content, {
        type: "text",
        text: adapterCase.expected.text,
      });
      assert.equal(message.occurred_at, fixedNow());

      if (adapterCase.expected.attachmentKind) {
        assert.equal(message.attachments.length, 1);
        assert.equal(message.attachments[0].kind, adapterCase.expected.attachmentKind);
      } else {
        assert.deepEqual(message.attachments, []);
      }
    });

    it(`normalizes outbound C2 Egress for ${adapterCase.name} and preserves idempotency`, () => {
      const delivery = adapterCase.normalizeOutgoing({
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: `${adapterCase.type}-out-1`,
        channel_id: adapterCase.expected.channelId,
        message: {
          message_id: `${adapterCase.type}-out-1`,
          organization_id: "org-1",
          channel_id: adapterCase.expected.channelId,
          channel_type: adapterCase.type,
          conversation_ref: adapterCase.expected.conversationRef,
          direction: "outbound",
          content: {
            type: "text",
            text: `${adapterCase.type} pong`,
          },
        },
      });

      assert.equal(delivery.idempotency_key, `${adapterCase.type}-out-1`);
      assert.equal(delivery.message_id, `${adapterCase.type}-out-1`);
      assert.equal(delivery.channel_type, adapterCase.type);
      assert.equal(delivery.conversation_ref, adapterCase.expected.conversationRef);
      assert.equal(delivery.external_payload.idempotency_key, `${adapterCase.type}-out-1`);
    });

    it(`publishes a non-placeholder C6 descriptor for ${adapterCase.name}`, () => {
      const adapter = adapterCase.createAdapter({
        coreIngressUrl: "http://core.local/internal/ingress/messages",
        fetchImpl: async () => new Response("{}", { status: 202 }),
        now: fixedNow,
      });

      assert.equal(adapter.capabilityDescriptor.contract, "C6.CapabilityDescriptor");
      assert.equal(adapter.capabilityDescriptor.channel_type, adapterCase.type);

      for (const capability of adapterCase.expected.supported) {
        assert.equal(
          adapter.capabilityDescriptor.capabilities[capability].supported,
          true,
          `${adapterCase.type}.${capability}`,
        );
      }

      for (const capability of adapterCase.expected.unsupported) {
        assert.equal(
          adapter.capabilityDescriptor.capabilities[capability].supported,
          false,
          `${adapterCase.type}.${capability}`,
        );
      }
    });
  }
});
