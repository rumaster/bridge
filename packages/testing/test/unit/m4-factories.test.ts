import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTestBroadcast,
  createTestBroadcastMessage,
  createTestBroadcastRecipient,
  createTestBroadcastStats,
  createTestEdgeMessageBufferEntry,
  createTestNotification,
  createTestNotificationSetting,
} from "../../src/db/factories.js";

describe("M4 broadcast factories", () => {
  it("creates campaign, recipient, message, and stats fixtures", () => {
    const broadcast = createTestBroadcast();
    const recipient = createTestBroadcastRecipient({
      organization_id: broadcast.organization_id,
      broadcast_id: broadcast.id,
    });
    const message = createTestBroadcastMessage({
      organization_id: broadcast.organization_id,
      broadcast_id: broadcast.id,
    });
    const stats = createTestBroadcastStats({
      organization_id: broadcast.organization_id,
      broadcast_id: broadcast.id,
      prepared: 1,
      sent: 1,
    });

    assert.equal(broadcast.status, "draft");
    assert.equal(recipient.broadcast_id, broadcast.id);
    assert.equal(message.broadcast_id, broadcast.id);
    assert.equal(stats.prepared, 1);
    assert.equal(stats.sent, 1);

    assert.throws(() => createTestBroadcast({ status: "paused" }), /broadcast.status/);
    assert.throws(
      () => createTestBroadcastStats({ failed: -1 }),
      /broadcast_stats.failed/,
    );
  });
});

describe("M4 notification factories", () => {
  it("creates notification and category-by-channel settings fixtures", () => {
    const notification = createTestNotification({ category: "critical" });
    const setting = createTestNotificationSetting({
      organization_id: notification.organization_id,
      user_id: notification.recipient_user_id,
      category: notification.category,
      channel: "telegram",
      enabled: false,
    });

    assert.equal(notification.status, "new");
    assert.equal(setting.category, "critical");
    assert.equal(setting.channel, "telegram");
    assert.equal(setting.enabled, false);

    assert.throws(
      () => createTestNotification({ status: "read" }),
      /notification.read_at is required/,
    );
    assert.throws(
      () => createTestNotificationSetting({ channel: "sms" }),
      /notification_setting.channel/,
    );
  });
});

describe("M4 edge buffer factory", () => {
  it("creates encrypted RF edge buffer fixtures with deduplication fields", () => {
    const entry = createTestEdgeMessageBufferEntry({ sequence_number: 7 });

    assert.equal(entry.sequence_number, 7);
    assert.equal(Buffer.isBuffer(entry.payload_encrypted), true);
    assert.equal(entry.forwarded_at, null);

    assert.throws(
      () => createTestEdgeMessageBufferEntry({ sequence_number: 0 }),
      /edge_message_buffer.sequence_number/,
    );
    assert.throws(
      () => createTestEdgeMessageBufferEntry({ payload_encrypted: Buffer.alloc(0) }),
      /edge_message_buffer.payload_encrypted/,
    );
  });
});
