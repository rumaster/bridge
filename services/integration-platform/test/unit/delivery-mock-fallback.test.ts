import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ChannelDeliveryError,
  createAdapterDeliveryChannel,
  createMockExternalChannel,
} from "../../src/delivery/index.js";

/**
 * T6 задача 5: в боевом профиле (`DELIVERY_ALLOW_MOCK_FALLBACK=false`, т.е. без
 * fallbackChannel) неподключённый канал завершается ошибкой `adapter_missing`, а
 * не «тихим» mock-успехом. С mock-профилем fallback ловит такие каналы (dev/CI).
 * Telegram на fallback не опирается — у него всегда есть реальный адаптер.
 */

describe("delivery mock fallback gating (T6/CP-2)", () => {
  it("fails loudly for an unconfigured channel when no mock fallback is wired", async () => {
    const channel = createAdapterDeliveryChannel({ adapters: {} });

    await assert.rejects(
      () => channel.deliver({ channelType: "sms", delivery: {}, idempotencyKey: "k1" }),
      (error: unknown) =>
        error instanceof ChannelDeliveryError &&
        error.category === "adapter_missing" &&
        error.retryable === false,
    );
  });

  it("routes an unconfigured channel to the mock only when a fallback is explicitly wired", async () => {
    const channel = createAdapterDeliveryChannel({
      adapters: {},
      fallbackChannel: createMockExternalChannel(),
    });

    const result = await channel.deliver({
      channelType: "sms",
      delivery: {
        idempotency_key: "k2",
        message: {
          message_id: "k2",
          organization_id: "org-1",
          channel_id: "chan-1",
          channel_type: "sms",
          direction: "outbound",
          conversation_ref: "sms-1",
          recipient_ref: "sms-1",
          content: { type: "text", text: "hi" },
        },
      },
      idempotencyKey: "k2",
    });

    assert.equal(result.delivered, true);
  });
});
