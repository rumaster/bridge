import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NonIngestibleMaxUpdateError, buildMaxIngress } from "../../src/edge-max-ingress.js";
import { stableMaxMessageId } from "../../src/edge-ids.js";

const ORG = "org-1";
const CHANNEL = "chan-1";
const NOW = () => "2026-07-12T10:00:00.000Z";

function messageUpdate(mid: string, chatId: string, userId: string, text: string) {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    message: {
      sender: { user_id: userId, name: "Client" },
      recipient: { chat_id: chatId, chat_type: "dialog" },
      timestamp: 1_700_000_000_000,
      body: { mid, seq: 1, text },
    },
  };
}

describe("edge MAX ingress normalization (M4)", () => {
  it("normalizes a real MAX message_created update into a C2 ingress envelope", () => {
    const ingress = buildMaxIngress({
      update: messageUpdate("mid-1", "chat-1", "user-1", "где заказ?"),
      organizationId: ORG,
      channelId: CHANNEL,
      now: NOW,
    });

    assert.equal(ingress.contract, "C2.IngressMessage");
    assert.equal(ingress.id, stableMaxMessageId(CHANNEL, "mid-1"));
    assert.equal(ingress.idempotency_key, stableMaxMessageId(CHANNEL, "mid-1"));

    const message = ingress.message;
    assert.equal(message.channel_type, "max");
    assert.equal(message.direction, "inbound");
    assert.equal(message.organization_id, ORG);
    assert.equal(message.channel_id, CHANNEL);
    assert.equal(message.conversation_ref, "chat-1"); // recipient.chat_id
    assert.equal(message.sender_ref, "user-1"); // sender.user_id
    assert.equal(message.external_message_id, "mid-1"); // body.mid
    assert.equal(message.content.type, "text");
    assert.equal(message.content.text, "где заказ?");
    assert.equal(message.occurred_at, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(message.identity, { type: "max_user", value: "user-1" });
  });

  it("is idempotent by mid: same update → same message_id", () => {
    const first = buildMaxIngress({
      update: messageUpdate("mid-77", "chat-1", "user-1", "hi"),
      organizationId: ORG,
      channelId: CHANNEL,
      now: NOW,
    });
    const again = buildMaxIngress({
      update: messageUpdate("mid-77", "chat-1", "user-1", "hi"),
      organizationId: ORG,
      channelId: CHANNEL,
      now: NOW,
    });
    assert.equal(first.message.message_id, again.message.message_id);
  });

  it("rejects a service update without a sender", () => {
    assert.throws(
      () =>
        buildMaxIngress({
          update: { update_type: "bot_started", timestamp: 1 },
          organizationId: ORG,
          channelId: CHANNEL,
          now: NOW,
        }),
      NonIngestibleMaxUpdateError,
    );
  });

  it("rejects a message with neither text nor attachments", () => {
    assert.throws(
      () =>
        buildMaxIngress({
          update: {
            message: { sender: { user_id: "user-1" }, recipient: { chat_id: "chat-1" }, body: {} },
          },
          organizationId: ORG,
          channelId: CHANNEL,
          now: NOW,
        }),
      NonIngestibleMaxUpdateError,
    );
  });
});
