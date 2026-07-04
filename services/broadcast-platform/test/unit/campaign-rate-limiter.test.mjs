import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBroadcastRateLimiter,
  resolveChannelRateLimit,
} from "../../src/campaign/index.mjs";

/**
 * Управляемые часы: время двигается только явными `advance(ms)`, что делает
 * проверки rate limiting детерминированными (ТЗ §14.6).
 */
function createControllableClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("SVC-BCAST M4 — rate limiting кампаний (ТЗ §14.6)", () => {
  it("не превышает лимит: за окно выдаёт не больше messages_per_minute токенов", async () => {
    const clock = createControllableClock();
    const waits = [];
    const limiter = createBroadcastRateLimiter({
      now: clock.now,
      sleep: async (ms) => {
        waits.push(ms);
        clock.advance(ms); // backpressure «проматывает» время на паузу.
      },
    });

    const messagesPerMinute = 60; // 1 токен в секунду.
    let acquired = 0;
    const start = clock.now();
    while (clock.now() - start < 60_000 && acquired < 200) {
      // burst=1: только 1 токен доступен сразу, дальше — строго по пополнению.
      // Ограничим ожидание, чтобы цикл завершился в пределах минуты.
      await limiter.acquire("org-1:web_chat", {
        messagesPerMinute,
        burst: 1,
        maxWaitMs: 120_000,
      });
      acquired += 1;
    }

    // За минуту при лимите 60/мин и burst=1 выдаётся не больше 1 (стартовый) +
    // 60 (пополнение) токенов. Ключевой инвариант — не превышаем заявленный лимит.
    assert.ok(
      acquired <= messagesPerMinute + 1,
      `выдано ${acquired} токенов при лимите ${messagesPerMinute}/мин`,
    );
    assert.ok(limiter.getMetrics().throttled_total > 0, "backpressure срабатывал");
  });

  it("изолирует вёдра по паре канал+организация", async () => {
    const clock = createControllableClock();
    const limiter = createBroadcastRateLimiter({ now: clock.now, sleep: async () => {} });

    await limiter.acquire("org-1:web_chat", { messagesPerMinute: 1, burst: 1 });
    // Другая пара не затронута исчерпанием первой — токен доступен сразу.
    const other = await limiter.acquire("org-2:web_chat", {
      messagesPerMinute: 1,
      burst: 1,
      maxWaitMs: 0,
    });
    assert.equal(other.waitedMs, 0);
  });

  it("применяет backpressure и учитывает ожидание в метриках", async () => {
    const clock = createControllableClock();
    const limiter = createBroadcastRateLimiter({
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });

    // burst=1: первый токен сразу, второй — после ожидания пополнения.
    const first = await limiter.acquire("org-1:web_chat", {
      messagesPerMinute: 60,
      burst: 1,
      maxWaitMs: 60_000,
    });
    const second = await limiter.acquire("org-1:web_chat", {
      messagesPerMinute: 60,
      burst: 1,
      maxWaitMs: 60_000,
    });

    assert.equal(first.waitedMs, 0);
    assert.ok(second.waitedMs > 0, "второй токен потребовал ожидания");
    assert.ok(limiter.getMetrics().backpressure_wait_ms_total > 0);
  });

  it("бросает при превышении maxWaitMs (защита от бесконечного backpressure)", async () => {
    const clock = createControllableClock();
    const limiter = createBroadcastRateLimiter({ now: clock.now, sleep: async () => {} });

    await limiter.acquire("org-1:web_chat", { messagesPerMinute: 1, burst: 1 });
    await assert.rejects(
      () => limiter.acquire("org-1:web_chat", { messagesPerMinute: 1, burst: 1, maxWaitMs: 0 }),
      /backpressure timeout/,
    );
  });
});

describe("SVC-BCAST M4 — учёт Capability каналов в лимите (C6)", () => {
  it("берёт минимум из политики кампании и лимита канала при channel_capability", () => {
    const descriptor = {
      capabilities: { text: { supported: true, constraints: { messages_per_minute: 30 } } },
    };

    assert.equal(
      resolveChannelRateLimit(descriptor, "text", {
        messages_per_minute: 120,
        strategy: "channel_capability",
      }),
      30,
    );
  });

  it("при стратегии fixed игнорирует лимит канала и берёт политику кампании", () => {
    const descriptor = {
      capabilities: { text: { supported: true, constraints: { messages_per_minute: 30 } } },
    };

    assert.equal(
      resolveChannelRateLimit(descriptor, "text", {
        messages_per_minute: 120,
        strategy: "fixed",
      }),
      120,
    );
  });
});
