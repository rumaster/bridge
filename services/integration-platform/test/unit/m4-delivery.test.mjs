import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ChannelDeliveryError,
  classifyDeliveryError,
} from "../../src/delivery/errors.mjs";
import { createBackoffPolicy } from "../../src/delivery/backoff.mjs";
import { createChannelRateLimiter } from "../../src/delivery/rate-limiter.mjs";
import { createMockExternalChannel } from "../../src/delivery/mock-external-channel.mjs";
import { createDeliveryEngine } from "../../src/delivery/delivery-engine.mjs";

function egressDelivery({ messageId, channelType = "telegram", organizationId = "11111111-1111-1111-1111-111111111111" }) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: "chan-1",
    message: {
      message_id: messageId,
      organization_id: organizationId,
      channel_id: "chan-1",
      channel_type: channelType,
      direction: "outbound",
      conversation_ref: "conv-1",
      content: { type: "text", text: "hello" },
    },
  };
}

function recordingBackendClient() {
  const attempts = [];
  return {
    attempts,
    async recordAttempt(attempt) {
      attempts.push({ ...attempt });
      return { recorded: true };
    },
  };
}

describe("M4 delivery — классификация ошибок доставки (ТЗ §10.8)", () => {
  it("429 повторяем как rate_limited", () => {
    const result = classifyDeliveryError(new ChannelDeliveryError("throttled", { status: 429 }));
    assert.equal(result.retryable, true);
    assert.equal(result.category, "rate_limited");
  });

  it("5xx повторяемы как server_error", () => {
    for (const status of [500, 502, 503, 504]) {
      const result = classifyDeliveryError(new ChannelDeliveryError("boom", { status }));
      assert.equal(result.retryable, true, `status ${status}`);
    }
  });

  it("4xx (кроме 408/425/429) неповторяемы", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const result = classifyDeliveryError(new ChannelDeliveryError("bad", { status }));
      assert.equal(result.retryable, false, `status ${status}`);
      assert.equal(result.category, "client_error");
    }
  });

  it("сетевые коды повторяемы", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
      const error = new Error("net");
      error.code = code;
      const result = classifyDeliveryError(error);
      assert.equal(result.retryable, true, `code ${code}`);
      assert.equal(result.category, "network");
    }
  });

  it("явный флаг retryable имеет приоритет", () => {
    const error = new ChannelDeliveryError("permanent", { status: 503, retryable: false });
    assert.equal(classifyDeliveryError(error).retryable, false);
  });

  it("неизвестные ошибки по умолчанию неповторяемы", () => {
    const result = classifyDeliveryError(new Error("mystery"));
    assert.equal(result.retryable, false);
    assert.equal(result.category, "unknown");
  });

  it("прокидывает retryAfterMs (Retry-After)", () => {
    const error = new ChannelDeliveryError("throttled", { status: 429, retryAfterMs: 2500 });
    assert.equal(classifyDeliveryError(error).retryAfterMs, 2500);
  });
});

describe("M4 delivery — экспоненциальный бэкофф (ТЗ §10.8)", () => {
  it("расписание растёт экспоненциально и ограничено maxDelayMs", () => {
    const policy = createBackoffPolicy({ baseDelayMs: 500, factor: 2, maxDelayMs: 4000, maxAttempts: 6 });
    assert.deepEqual(policy.schedule(), [500, 1000, 2000, 4000, 4000]);
  });

  it("maxAttempts ограничивает число попыток", () => {
    const policy = createBackoffPolicy({ maxAttempts: 3 });
    assert.equal(policy.maxAttempts, 3);
    assert.equal(policy.schedule().length, 2);
  });

  it("Retry-After поднимает задержку не ниже подсказки", () => {
    const policy = createBackoffPolicy({ baseDelayMs: 500, factor: 2, maxDelayMs: 60000 });
    assert.equal(policy.delayForAttempt(1, { retryAfterMs: 5000 }), 5000);
  });

  it("джиттер детерминирован при инъекции random", () => {
    const policy = createBackoffPolicy({ baseDelayMs: 1000, jitter: true, random: () => 0.25 });
    assert.equal(policy.delayForAttempt(1), 250);
  });

  it("отклоняет некорректные параметры", () => {
    assert.throws(() => createBackoffPolicy({ factor: 0.5 }), TypeError);
    assert.throws(() => createBackoffPolicy({ maxAttempts: 0 }), TypeError);
    assert.throws(() => createBackoffPolicy({ baseDelayMs: 10, maxDelayMs: 5 }), TypeError);
  });
});

describe("M4 delivery — rate limiting на канал (ТЗ §10.9)", () => {
  it("списывает токены и троттлит при исчерпании", () => {
    let clock = 0;
    const limiter = createChannelRateLimiter({
      limits: { telegram: { capacity: 2, refillTokens: 2, refillIntervalMs: 1000 } },
      now: () => clock,
    });

    assert.equal(limiter.tryAcquire("telegram").allowed, true);
    assert.equal(limiter.tryAcquire("telegram").allowed, true);
    const throttled = limiter.tryAcquire("telegram");
    assert.equal(throttled.allowed, false);
    assert.ok(throttled.retryAfterMs > 0);
  });

  it("пополняет ведро со временем", () => {
    let clock = 0;
    const limiter = createChannelRateLimiter({
      limits: { sms: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 } },
      now: () => clock,
    });
    assert.equal(limiter.tryAcquire("sms").allowed, true);
    assert.equal(limiter.tryAcquire("sms").allowed, false);
    clock = 1000;
    assert.equal(limiter.tryAcquire("sms").allowed, true);
  });

  it("изолирует нагрузку между каналами", () => {
    const limiter = createChannelRateLimiter({
      limits: {
        telegram: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
        email: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
      },
      now: () => 0,
    });
    assert.equal(limiter.tryAcquire("telegram").allowed, true);
    assert.equal(limiter.tryAcquire("telegram").allowed, false);
    // email не затронут исчерпанием telegram
    assert.equal(limiter.tryAcquire("email").allowed, true);
  });

  it("backpressure ждёт пополнения и списывает токен", async () => {
    let clock = 0;
    const waits = [];
    const limiter = createChannelRateLimiter({
      limits: { vk: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 } },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    assert.equal(limiter.tryAcquire("vk").allowed, true);
    const acquired = await limiter.acquire("vk");
    assert.ok(waits.length >= 1);
    assert.ok(acquired.waitedMs > 0);
    assert.equal(limiter.getMetrics().backpressure_waits_total, waits.length);
  });
});

describe("M4 delivery — идемпотентность мока внешнего канала (ТЗ §11.12)", () => {
  it("повтор с обработанным ключом не создаёт второе сообщение", async () => {
    const channel = createMockExternalChannel();
    const first = await channel.deliver({ idempotencyKey: "m-1", channelType: "telegram", message: {} });
    const second = await channel.deliver({ idempotencyKey: "m-1", channelType: "telegram", message: {} });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.external_message_id, first.external_message_id);
    assert.equal(channel.deliveredCount, 1);
  });

  it("lost-ack: сообщение записано, повтор — идемпотентный отбой", async () => {
    const channel = createMockExternalChannel({ outcomes: { "m-2": ["lost-ack"] } });
    await assert.rejects(() => channel.deliver({ idempotencyKey: "m-2", channelType: "sms", message: {} }));
    const retry = await channel.deliver({ idempotencyKey: "m-2", channelType: "sms", message: {} });
    assert.equal(retry.duplicate, true);
    assert.equal(channel.deliveredCount, 1);
  });
});

describe("M4 delivery — движок доставки", () => {
  const noSleep = async () => {};

  it("успех: одна попытка, запись в message_delivery_attempts", async () => {
    const backend = recordingBackendClient();
    const engine = createDeliveryEngine({
      channel: createMockExternalChannel(),
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 3 }),
      sleep: noSleep,
    });

    const result = await engine.deliver(egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000000001" }));
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 1);
    assert.equal(backend.attempts.length, 1);
    assert.equal(backend.attempts[0].status, "delivered");
    assert.equal(backend.attempts[0].attemptNo, 1);
  });

  it("ретрай повторяемой ошибки с последующим успехом", async () => {
    const backend = recordingBackendClient();
    const messageId = "aaaaaaaa-0000-0000-0000-000000000002";
    const channel = createMockExternalChannel({
      outcomes: { [messageId]: [{ status: 503, retryable: true }, { status: 503, retryable: true }] },
    });
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 5 }),
      sleep: noSleep,
    });

    const result = await engine.deliver(egressDelivery({ messageId }));
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 3);
    assert.equal(channel.deliveredCount, 1);
    // 2 failed + 1 delivered
    assert.deepEqual(
      backend.attempts.map((a) => a.status),
      ["failed", "failed", "delivered"],
    );
    assert.deepEqual(
      backend.attempts.map((a) => a.attemptNo),
      [1, 2, 3],
    );
  });

  it("неповторяемая ошибка не ретраится", async () => {
    const backend = recordingBackendClient();
    const messageId = "aaaaaaaa-0000-0000-0000-000000000003";
    const channel = createMockExternalChannel({
      outcomes: { [messageId]: [{ status: 400 }] },
    });
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 5 }),
      sleep: noSleep,
    });

    const result = await engine.deliver(egressDelivery({ messageId }));
    assert.equal(result.delivered, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.error_category, "client_error");
    assert.equal(backend.attempts.length, 1);
  });

  it("исчерпание попыток -> failed", async () => {
    const backend = recordingBackendClient();
    const messageId = "aaaaaaaa-0000-0000-0000-000000000004";
    const channel = createMockExternalChannel({
      outcomes: {
        [messageId]: [
          { status: 503, retryable: true },
          { status: 503, retryable: true },
          { status: 503, retryable: true },
        ],
      },
    });
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 3 }),
      sleep: noSleep,
    });

    const result = await engine.deliver(egressDelivery({ messageId }));
    assert.equal(result.delivered, false);
    assert.equal(result.attempts, 3);
    assert.equal(backend.attempts.length, 3);
    assert.equal(channel.deliveredCount, 0);
  });

  it("lost-ack: ретрай без дубля внешнего сообщения (ТЗ §11.12)", async () => {
    const backend = recordingBackendClient();
    const messageId = "aaaaaaaa-0000-0000-0000-000000000005";
    const channel = createMockExternalChannel({ outcomes: { [messageId]: ["lost-ack"] } });
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 3 }),
      sleep: noSleep,
    });

    const result = await engine.deliver(egressDelivery({ messageId }));
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 2);
    assert.equal(channel.deliveredCount, 1);
  });

  it("повторный egress с тем же idempotency_key отбрасывается", async () => {
    const backend = recordingBackendClient();
    const messageId = "aaaaaaaa-0000-0000-0000-000000000006";
    const channel = createMockExternalChannel();
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 3 }),
      sleep: noSleep,
    });

    const first = await engine.deliver(egressDelivery({ messageId }));
    const second = await engine.deliver(egressDelivery({ messageId }));
    assert.equal(first.delivered, true);
    assert.equal(second.duplicate, true);
    assert.equal(channel.deliveredCount, 1);
    // Второй вызов не пишет новую попытку.
    assert.equal(backend.attempts.length, 1);
    assert.equal(engine.getMetrics().duplicate_total, 1);
  });

  it("idempotency_key обязан совпадать с message_id", async () => {
    const engine = createDeliveryEngine({
      channel: createMockExternalChannel(),
      backendClient: recordingBackendClient(),
      sleep: noSleep,
    });
    const delivery = egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000000007" });
    delivery.idempotency_key = "mismatch";
    await assert.rejects(() => engine.deliver(delivery), TypeError);
  });

  it("недоступность Backend не роняет доставку", async () => {
    const failingBackend = {
      async recordAttempt() {
        throw new Error("backend down");
      },
    };
    const engine = createDeliveryEngine({
      channel: createMockExternalChannel(),
      backendClient: failingBackend,
      sleep: noSleep,
    });
    const result = await engine.deliver(egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000000008" }));
    assert.equal(result.delivered, true);
    assert.equal(engine.getMetrics().attempt_record_failures_total, 1);
  });
});
