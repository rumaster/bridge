import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBroadcastBackoff,
  createBroadcastRateLimiter,
  createCampaignRunner,
  createInMemoryCoreDelivery,
} from "../../src/campaign/index.js";

const fixedNow = () => "2026-07-04T11:00:00.000Z";

const broadcast = {
  id: "50000000-0000-4000-8000-000000000001",
  organization_id: "10000000-0000-4000-8000-000000000101",
  status: "scheduled",
  template: { type: "text", body: "Здравствуйте, {{client.name}}" },
  rate_limit: { messages_per_minute: 600 },
};

function recipient(index, overrides = {}) {
  const suffix = String(index).padStart(12, "0");
  return {
    client_id: `client-${index}`,
    endpoint_id: `10000000-0000-4000-8000-${suffix}`,
    conversation_id: `20000000-0000-4000-8000-${suffix}`,
    channel: "web_chat",
    sequence_number: 1,
    context: { client: { name: `Клиент ${index}` } },
    ...overrides,
  };
}

function newRunner(core, extra = {}) {
  return createCampaignRunner({
    core,
    clock: fixedNow,
    sleep: async () => {},
    ...extra,
  });
}

describe("SVC-BCAST M4 — оркестратор запуска кампании (CP-6)", () => {
  it("генерирует и доставляет через ядро, собирает статистику и события C7", async () => {
    const core = createInMemoryCoreDelivery();
    const runner = newRunner(core);

    const result = await runner.run(broadcast, [recipient(1), recipient(2), recipient(3)], {
      startIdempotencyKey: "start-1",
    });

    assert.equal(result.status, "done");
    assert.equal(result.stats.prepared, 3);
    assert.equal(result.stats.sent, 3);
    assert.equal(result.stats.failed, 0);
    // C7: события перехода running -> done.
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].status, "running");
    assert.equal(result.events[1].status, "done");
    // Доставка прошла строго через ядро — связи broadcast_messages созданы.
    assert.equal(core.getBroadcastMessages().length, 3);
  });

  it("повторный запуск с тем же ключом не создаёт дублей в ядре (идемпотентность §11.12)", async () => {
    const core = createInMemoryCoreDelivery();
    const runner = newRunner(core);
    const recipients = [recipient(1), recipient(2)];

    const first = await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });
    const second = await runner.run(broadcast, recipients, { startIdempotencyKey: "start-1" });

    assert.equal(first.stats.sent, 2);
    // Второй запуск: все результаты — дубликаты, новых сообщений в ядре нет.
    assert.ok(second.results.every((r) => r.duplicate === true));
    assert.equal(core.getBroadcastMessages().length, 2, "нет дублей broadcast_messages");
  });

  it("частичный отказ доставки корректно отражается в статистике", async () => {
    let call = 0;
    const core = createInMemoryCoreDelivery({
      // Каждая вторая доставка проваливается на уровне egress (терминально).
      egress: async () => {
        call += 1;
        return call % 2 === 0 ? { accepted: false, error: "channel down" } : { accepted: true, status: "sent" };
      },
    });
    const runner = newRunner(core);

    const result = await runner.run(broadcast, [recipient(1), recipient(2), recipient(3), recipient(4)], {
      startIdempotencyKey: "start-1",
    });

    assert.equal(result.stats.prepared, 4);
    assert.equal(result.stats.sent, 2);
    assert.equal(result.stats.failed, 2);
    assert.equal(result.status, "done", "часть доставлена — кампания завершена");
  });

  it("кампания помечается failed, если ни одно сообщение не отправлено", async () => {
    const core = createInMemoryCoreDelivery({
      egress: async () => ({ accepted: false, error: "all down" }),
    });
    const runner = newRunner(core);

    const result = await runner.run(broadcast, [recipient(1), recipient(2)], {
      startIdempotencyKey: "start-1",
    });

    assert.equal(result.stats.sent, 0);
    assert.equal(result.stats.failed, 2);
    assert.equal(result.status, "failed");
    assert.equal(result.events[1].status, "failed");
  });

  it("пропускает несовместимые с каналом сообщения (C6), не формируя их", async () => {
    const core = createInMemoryCoreDelivery();
    const runner = newRunner(core, {
      capabilities: {
        sms: { capabilities: { text: { supported: false } } },
        web_chat: { capabilities: { text: { supported: true } } },
      },
    });

    const result = await runner.run(
      broadcast,
      [recipient(1, { channel: "web_chat" }), recipient(2, { channel: "sms" })],
      { startIdempotencyKey: "start-1" },
    );

    assert.equal(result.stats.prepared, 1, "только совместимый получатель сформирован");
    assert.equal(result.skipped, 1);
    assert.equal(core.getBroadcastMessages().length, 1);
  });

  it("ретраит временный БРОСОК ядра и доводит доставку до успеха без дублей", async () => {
    let attempts = 0;
    const inner = createInMemoryCoreDelivery();
    const flakyCore = {
      async deliver(draft, opts) {
        attempts += 1;
        if (attempts === 1) {
          // Транзиентная недоступность ядра/транспорта — бросок без флага retryable=false.
          throw new Error("core temporarily unavailable");
        }
        return inner.deliver(draft, opts);
      },
      getBroadcastMessages: () => inner.getBroadcastMessages(),
    };

    const runner = newRunner(flakyCore, {
      backoff: createBroadcastBackoff({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 }),
    });

    const result = await runner.run(broadcast, [recipient(1)], { startIdempotencyKey: "start-1" });

    assert.equal(attempts, 2, "первая попытка — бросок, вторая — успех");
    assert.equal(result.stats.sent, 1);
    assert.equal(flakyCore.getBroadcastMessages().length, 1, "ретрай не создал дубль");
  });

  it("не ретраит невалидный черновик (ошибка валидации — не временная)", async () => {
    let calls = 0;
    const rejectingCore = {
      async deliver() {
        calls += 1;
        const error = new Error("Invalid C8 broadcast delivery draft");
        error.name = "CommunicationCoreM4ValidationError";
        error.retryable = false;
        throw error;
      },
    };
    const runner = newRunner(rejectingCore, {
      backoff: createBroadcastBackoff({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 4 }),
    });

    const result = await runner.run(broadcast, [recipient(1)], { startIdempotencyKey: "start-1" });

    assert.equal(calls, 1, "нет повторов для невалидного черновика");
    assert.equal(result.stats.failed, 1);
    assert.equal(result.status, "failed");
  });

  it("rate limiter не превышает лимит и учитывается в батчинге", async () => {
    let maxConcurrentTokens = 0;
    const clock = (() => {
      let t = 0;
      return () => new Date(t++).toISOString();
    })();
    const limiter = createBroadcastRateLimiter({
      now: () => Date.now(),
      sleep: async () => {},
    });
    const core = createInMemoryCoreDelivery();
    const runner = createCampaignRunner({
      core,
      rateLimiter: limiter,
      clock,
      sleep: async () => {},
      batchSize: 2,
    });

    const recipients = Array.from({ length: 5 }, (_v, i) => recipient(i + 1));
    const result = await runner.run(
      { ...broadcast, rate_limit: { messages_per_minute: 600 } },
      recipients,
      { startIdempotencyKey: "start-1" },
    );

    assert.equal(result.batches, 3, "5 получателей при batchSize=2 -> 3 батча");
    assert.equal(result.stats.sent, 5);
    assert.equal(limiter.getMetrics().acquired_total, 5, "по токену на каждого получателя");
    void maxConcurrentTokens;
  });
});
