import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MESSAGE_STATUS } from "../../../../packages/contracts/message-model/index.mjs";
import { createBroadcastStats } from "../../src/campaign/index.mjs";

const fixedNow = () => "2026-07-04T10:00:00.000Z";

describe("SVC-BCAST M4 — сбор статистики broadcast_stats (ТЗ §14.8)", () => {
  it("считает частичный отказ: prepared/sent/delivered/failed из статусов ядра", () => {
    const stats = createBroadcastStats({ now: fixedNow });

    // Пять получателей: 2 доставлены, 1 отправлено (в пути), 2 провалены.
    for (let index = 0; index < 5; index += 1) {
      stats.markPrepared();
    }
    stats.recordStatus(MESSAGE_STATUS.DELIVERED);
    stats.recordStatus(MESSAGE_STATUS.DELIVERED);
    stats.recordStatus(MESSAGE_STATUS.SENT);
    stats.recordStatus(MESSAGE_STATUS.FAILED);
    stats.recordStatus(MESSAGE_STATUS.FAILED);

    const snapshot = stats.snapshot();
    assert.equal(snapshot.prepared, 5);
    assert.equal(snapshot.sent, 3, "delivered входят в sent");
    assert.equal(snapshot.delivered, 2);
    assert.equal(snapshot.failed, 2);
    assert.equal(snapshot.updated_at, "2026-07-04T10:00:00.000Z");
  });

  it("держит инварианты C8: delivered <= sent <= prepared и delivered+failed <= sent", () => {
    const stats = createBroadcastStats({ now: fixedNow });
    for (let index = 0; index < 4; index += 1) {
      stats.markPrepared();
    }
    stats.recordStatus(MESSAGE_STATUS.DELIVERED);
    stats.recordStatus(MESSAGE_STATUS.SENT);
    stats.recordStatus(MESSAGE_STATUS.FAILED);

    const { prepared, sent, delivered, failed } = stats.snapshot();
    assert.ok(delivered <= sent, "delivered <= sent");
    assert.ok(sent <= prepared, "sent <= prepared");
    assert.ok(delivered + failed <= sent, "delivered + failed <= sent");
  });

  it("не учитывает промежуточные статусы (routed) в агрегатах", () => {
    const stats = createBroadcastStats({ now: fixedNow });
    stats.markPrepared();
    stats.recordStatus(MESSAGE_STATUS.ROUTED);

    const snapshot = stats.snapshot();
    assert.equal(snapshot.prepared, 1);
    assert.equal(snapshot.sent, 0);
    assert.equal(snapshot.failed, 0);
  });

  it("пропущенные получатели учитываются отдельно и не входят в prepared", () => {
    const stats = createBroadcastStats({ now: fixedNow });
    stats.markPrepared();
    stats.markSkipped();
    stats.markSkipped();

    assert.equal(stats.snapshot().prepared, 1);
    assert.equal(stats.skipped(), 2);
  });
});
