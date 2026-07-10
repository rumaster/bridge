import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNotificationTriggerEvent } from "../../../../packages/contracts/src/c10.js";
import { createDefaultChannelAdapters } from "../../src/channel-adapters.js";
import { createDeterministicNotificationMock } from "../../src/deterministic-notification.js";

const fixedNow = () => "2026-07-04T09:30:00.000Z";
const ORG = "org-1";
const USER = "manager-1";

function triggerEvent(overrides = {}) {
  return createNotificationTriggerEvent({
    eventId: "evt-1",
    producerServiceId: "SVC-CORE",
    producerEventId: "message-1:created",
    organizationId: ORG,
    recipientUserId: USER,
    category: "critical",
    title: "New priority message",
    body: "Client sent a priority message.",
    payload: { conversation_id: "conversation-1" },
    dedupeKey: "SVC-CORE:message-1:manager-1",
    occurredAt: fixedNow(),
    ...overrides,
  });
}

describe("G-8 SVC-NOTIF → SVC-TGC telegram forward (integration)", () => {
  it("forwards the telegram card to SVC-TGC when a producer event is accepted", async () => {
    const forwardCalls: Array<{ url: string; body: any }> = [];
    const channels: any = createDefaultChannelAdapters({
      now: fixedNow,
      telegramForwardUrl: "http://svc-tgc.test",
      fetchImpl: async (url: any, init: any) => {
        forwardCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ status: "delivered" }), { status: 202 });
      },
    });
    const mock = createDeterministicNotificationMock({ now: fixedNow, channels });

    const result = mock.acceptProducerEvent(triggerEvent());

    // Telegram — среди фактических каналов доставки, провайдер SVC-TGC.
    const telegramDelivery = result.deliveries.find((record: any) => record.channel === "telegram");
    assert.ok(telegramDelivery, "telegram delivery record present");
    assert.equal(telegramDelivery.status, "sent");
    assert.equal(telegramDelivery.provider, "svc-tgc");

    // Реальный форвард в SVC-TGC произошёл с карточкой уведомления.
    await channels.telegram.drain();
    assert.equal(forwardCalls.length, 1);
    assert.equal(forwardCalls[0].url, "http://svc-tgc.test/internal/notifications/telegram");
    assert.equal(forwardCalls[0].body.notification.recipient_user_id, USER);
    assert.ok(forwardCalls[0].body.notification.channels.includes("telegram"));
    assert.equal(forwardCalls[0].body.notification.id, telegramDelivery.notification_id ?? result.notification.id);
  });

  it("does not forward when telegram is disabled in the recipient's subscriptions", async () => {
    const forwardCalls: unknown[] = [];
    const channels: any = createDefaultChannelAdapters({
      now: fixedNow,
      telegramForwardUrl: "http://svc-tgc.test",
      fetchImpl: async () => {
        forwardCalls.push(1);
        return new Response("{}", { status: 202 });
      },
    });
    const mock = createDeterministicNotificationMock({ now: fixedNow, channels });
    mock.updateNotificationSettings(
      { organizationId: ORG, userId: USER },
      {
        contract: "C10.UpdateNotificationSettingsRequest",
        version: "1.0.0",
        request_id: "req-settings",
        organization_id: ORG,
        user_id: USER,
        settings: [
          { category: "critical", channel: "web", enabled: true },
          { category: "critical", channel: "telegram", enabled: false },
        ],
      },
    );

    const result = mock.acceptProducerEvent(triggerEvent());

    assert.ok(result.skipped_channels.includes("telegram"));
    await channels.telegram.drain();
    assert.equal(forwardCalls.length, 0);
  });
});
