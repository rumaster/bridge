import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBroadcastBackoff } from "../../src/campaign/index.mjs";

describe("SVC-BCAST M4 — экспоненциальный бэкофф ретраев (ТЗ §14.9)", () => {
  it("рассчитывает задержки как base * factor^(n-1) с потолком maxDelayMs", () => {
    const backoff = createBroadcastBackoff({
      baseDelayMs: 100,
      factor: 2,
      maxDelayMs: 1000,
      maxAttempts: 6,
    });

    assert.equal(backoff.delayForAttempt(1), 100);
    assert.equal(backoff.delayForAttempt(2), 200);
    assert.equal(backoff.delayForAttempt(3), 400);
    assert.equal(backoff.delayForAttempt(4), 800);
    // 1600 > maxDelayMs — обрезается до потолка.
    assert.equal(backoff.delayForAttempt(5), 1000);
  });

  it("расписание не превышает потолок и ограничено числом попыток", () => {
    const backoff = createBroadcastBackoff({
      baseDelayMs: 250,
      factor: 2,
      maxDelayMs: 10_000,
      maxAttempts: 4,
    });

    const schedule = backoff.schedule();
    assert.equal(schedule.length, 3, "между 4 попытками — 3 паузы");
    for (const delay of schedule) {
      assert.ok(delay <= 10_000, `задержка ${delay} в пределах потолка`);
    }
    assert.deepEqual(schedule, [250, 500, 1000]);
  });

  it("валидирует параметры конфигурации", () => {
    assert.throws(() => createBroadcastBackoff({ factor: 0.5 }), /factor/);
    assert.throws(() => createBroadcastBackoff({ maxAttempts: 0 }), /maxAttempts/);
    assert.throws(
      () => createBroadcastBackoff({ baseDelayMs: 100, maxDelayMs: 50 }),
      /maxDelayMs/,
    );
  });
});
