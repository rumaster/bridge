import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createBackendDeliveryClient,
  DELIVERY_ATTEMPT_CONTRACT,
  DELIVERY_ATTEMPT_STATUSES,
  DELIVERY_ATTEMPT_VERSION,
} from "../../services/integration-platform/src/delivery/index.js";

const root = process.cwd();
const fixedNow = () => "2026-07-04T10:00:00.000Z";

// Контракт фиксации попыток доставки (CP-6, M4): SVC-INT не имеет прямого
// доступа к БД (ТЗ §22.3) и пишет попытки в message_delivery_attempts через
// Backend. Тест закрепляет соответствие тела запроса колонкам таблицы и
// перечню статусов, чтобы схема БД и клиент не разъезжались.
describe("CP-6 SVC-INT delivery attempts contract", () => {
  const migration = readFileSync(
    join(root, "db/migrations/20260703093000000_m1_schema.sql"),
    "utf8",
  );

  it("перечень статусов клиента совпадает с CHECK-ограничением таблицы", () => {
    assert.deepEqual(DELIVERY_ATTEMPT_STATUSES, [
      "pending",
      "sent",
      "delivered",
      "failed",
    ]);
    const statusList = DELIVERY_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(", ");
    assert.match(
      migration,
      new RegExp(`status IN \\(${statusList.replace(/[()]/g, "\\$&")}\\)`),
    );
  });

  it("тело DeliveryAttempt содержит поля колонок message_delivery_attempts", async () => {
    let captured;
    const client = createBackendDeliveryClient({
      baseUrl: "http://backend.local",
      now: fixedNow,
      fetchImpl: async (url, init) => {
        captured = { url, body: JSON.parse(init.body as string), method: init.method };
        return new Response(JSON.stringify({ recorded: true }), { status: 201 });
      },
    });

    const result = await client.recordAttempt({
      organizationId: "10000000-0000-4000-8000-000000000601",
      messageId: "10000000-0000-4000-8000-000000000602",
      adapter: "telegram",
      attemptNo: 2,
      status: "delivered",
      error: null,
    });

    assert.equal(result.recorded, true);
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "http://backend.local/internal/delivery/attempts");

    const body = captured.body;
    assert.equal(body.contract, DELIVERY_ATTEMPT_CONTRACT);
    assert.equal(body.version, DELIVERY_ATTEMPT_VERSION);
    // Поля тела ↔ колонки таблицы message_delivery_attempts.
    for (const column of [
      "organization_id",
      "message_id",
      "adapter",
      "attempt_no",
      "status",
      "error",
    ]) {
      assert.ok(column in body, `missing field ${column}`);
    }
    assert.equal(body.attempt_no, 2);
    assert.equal(body.status, "delivered");
    assert.ok(DELIVERY_ATTEMPT_STATUSES.includes(body.status));
  });

  it("отклоняет статус вне перечня контракта", async () => {
    const client = createBackendDeliveryClient({
      baseUrl: "http://backend.local",
      fetchImpl: async () => new Response("{}", { status: 201 }),
    });

    await assert.rejects(
      () =>
        client.recordAttempt({
          organizationId: "org",
          messageId: "msg",
          adapter: "telegram",
          attemptNo: 1,
          status: "acknowledged",
        }),
      TypeError,
    );
  });
});
