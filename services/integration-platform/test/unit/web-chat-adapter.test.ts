import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WEB_CHAT_CHANNEL_TYPE,
  createWebChatAdapter,
  normalizeIncomingWebChatMessage,
} from "../../src/adapters/web-chat/web-chat-adapter.js";

describe("Web Chat adapter normalization", () => {
  it("normalizes inbound Web Chat text and attachments into C1 and preserves idempotency", () => {
    const message = normalizeIncomingWebChatMessage(
      {
        organization_id: "org-1",
        channel_id: "channel-web",
        message_id: "web-msg-1",
        session_id: "session-1",
        sender_ref: "visitor-1",
        text: "Здравствуйте",
        attachments: [
          {
            id: "attachment-1",
            kind: "image",
            storage_ref: "blob://image-1",
            mime: "image/png",
            filename: "screen.png",
            size: 1024,
          },
        ],
      },
      () => "2026-07-03T09:00:00.000Z",
    );

    assert.equal(message.message_id, "web-msg-1");
    assert.equal(message.channel_type, WEB_CHAT_CHANNEL_TYPE);
    assert.equal(message.direction, "inbound");
    assert.deepEqual(message.content, {
      type: "text",
      text: "Здравствуйте",
    });
    assert.deepEqual(message.attachments, [
      {
        id: "attachment-1",
        kind: "image",
        storage_ref: "blob://image-1",
        mime: "image/png",
        filename: "screen.png",
        size: 1024,
      },
    ]);
    assert.equal(message.occurred_at, "2026-07-03T09:00:00.000Z");
  });

  it("keeps the M1 Web Chat Endpoint payload compatible with the C2 envelope", () => {
    const message = normalizeIncomingWebChatMessage(
      {
        organization_id: "org-1",
        conversation_id: "conversation-1",
        endpoint_id: "channel-web",
        visitor_session_id: "visitor-1",
        idempotency_key: "web-msg-legacy-1",
        body: {
          type: "text",
          text: "legacy ping",
        },
      },
      () => "2026-07-03T09:00:00.000Z",
    );

    assert.equal(message.message_id, "web-msg-legacy-1");
    assert.equal(message.idempotency_key, "web-msg-legacy-1");
    assert.equal(message.channel_id, "channel-web");
    assert.equal(message.conversation_ref, "conversation-1");
    assert.equal(message.sender_ref, "visitor-1");
    assert.deepEqual(message.content, {
      type: "text",
      text: "legacy ping",
    });
  });

  it("publishes Web Chat C6 capabilities with only actually supported features enabled", () => {
    const adapter = createWebChatAdapter({
      coreIngressUrl: "http://core.local/internal/ingress/messages",
      fetchImpl: async () => new Response("{}", { status: 202 }),
    });

    assert.equal(adapter.capabilityDescriptor.channel_type, WEB_CHAT_CHANNEL_TYPE);
    assert.equal(adapter.capabilityDescriptor.capabilities.text.supported, true);
    // WG-14: вложения не заявляются — сквозняк их не переносит (ядро хранит text).
    assert.equal(adapter.capabilityDescriptor.capabilities.image.supported, false);
    assert.equal(adapter.capabilityDescriptor.capabilities.file.supported, false);
    assert.equal(
      adapter.capabilityDescriptor.capabilities.typing_indicator.supported,
      true,
    );
    assert.equal(adapter.capabilityDescriptor.capabilities.read_receipt.supported, true);
    assert.equal(adapter.capabilityDescriptor.capabilities.voice.supported, false);
    assert.equal(adapter.capabilityDescriptor.capabilities.buttons.supported, false);
  });
});
