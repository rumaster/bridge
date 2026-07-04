import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMockTelegramApiAdapter,
  createReliableTelegramApiAdapter,
} from "../../src/index.mjs";

const START = Date.parse("2026-07-04T10:00:00.000Z");

describe("Telegram Console M5 Telegram delivery queue", () => {
  it("serializes sendMessage calls and throttles one chat by the configured interval", async () => {
    const clock = createControllableClock();
    const telegramApi = createMockTelegramApiAdapter({ now: clock.iso });
    const reliableTelegramApi = createReliableTelegramApiAdapter({
      telegramApi,
      now: clock.now,
      sleep: clock.sleep,
      limits: {
        globalIntervalMs: 0,
        perChatIntervalMs: 1_000,
        groupChatIntervalMs: 3_000,
      },
    });

    await reliableTelegramApi.sendMessage({ chat_id: 1001, text: "one" });
    await reliableTelegramApi.sendMessage({ chat_id: 1001, text: "two" });
    await reliableTelegramApi.sendMessage({ chat_id: 1001, text: "three" });

    assert.deepEqual(clock.waits, [1_000, 1_000]);
    assert.deepEqual(
      telegramApi.getSentMessages().map((message) => message.sent_at),
      [
        "2026-07-04T10:00:00.000Z",
        "2026-07-04T10:00:01.000Z",
        "2026-07-04T10:00:02.000Z",
      ],
    );
    assert.equal(reliableTelegramApi.getMetrics().rate_limit_wait_ms_total, 2_000);
  });

  it("honors Telegram retry_after on 429 before retrying the same queued operation", async () => {
    const clock = createControllableClock();
    const attempts = [];
    const telegramApi = {
      async sendMessage(payload) {
        attempts.push({ at: clock.now(), payload });
        if (attempts.length === 1) {
          const error = new Error("Too Many Requests");
          error.status = 429;
          error.parameters = { retry_after: 2 };
          throw error;
        }

        return {
          message_id: "mock-message-retry",
          chat_id: payload.chat_id,
          text: payload.text,
          sent_at: clock.iso(),
          mock: true,
        };
      },

      async answerCallbackQuery() {
        return { ok: true };
      },
    };
    const reliableTelegramApi = createReliableTelegramApiAdapter({
      telegramApi,
      now: clock.now,
      sleep: clock.sleep,
      limits: {
        globalIntervalMs: 0,
        perChatIntervalMs: 0,
        groupChatIntervalMs: 0,
      },
      backoff: {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxAttempts: 3,
      },
    });

    const sent = await reliableTelegramApi.sendMessage({ chat_id: 1001, text: "retry me" });

    assert.equal(sent.message_id, "mock-message-retry");
    assert.deepEqual(
      attempts.map((attempt) => attempt.at),
      [START, START + 2_000],
    );
    assert.deepEqual(clock.waits, [2_000]);
    assert.equal(reliableTelegramApi.getMetrics().retries_total, 1);
  });
});

function createControllableClock(start = START) {
  let current = start;
  const waits = [];

  return {
    waits,
    now: () => current,
    iso: () => new Date(current).toISOString(),
    sleep: async (ms) => {
      waits.push(ms);
      current += ms;
    },
  };
}
