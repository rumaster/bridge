import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.js";
import { createFbpRuntime } from "../../services/fbp-engine/src/engine.js";
import { VersionImmutabilityError } from "../../services/fbp-engine/src/core/errors.js";

/**
 * e2e вехи M4-10 (SVC-FBP): неизменяемые версии, version pinning и
 * stateless-масштабирование — на РЕАЛЬНОМ рантайме движка без Docker/БД.
 *
 * Контрольный сценарий: экземпляры, запущенные до публикации новой версии,
 * доигрывают НА СВОЕЙ версии; новая версия влияет только на последующие старты,
 * а переключение версии по умолчанию делается конфигурацией (ТЗ §13.10, §25.3).
 */

const ORG = "10000000-0000-4000-8000-0000000000a1";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

const context = { organization_id: ORG, actor_user_id: "manager-a", trigger: "manual" };

// Схема двух шагов с точкой ожидания: version-маркер «зашит» в результат prepare,
// поэтому по финальному выводу видно, на КАКОЙ версии доигран экземпляр.
function approvalSchema(marker) {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-orders",
    entry: "prepare",
    nodes: [
      {
        id: "prepare",
        type: "transform",
        input: { title: { kind: "params", path: ["title"] } },
        config: { expression: { op: "merge", args: [{ op: "input" }, { op: "lit", value: { engine_version: marker } }] } },
      },
      { id: "await_approval", type: "wait-event", config: { event_type: "order.approved" } },
      {
        id: "create",
        type: "backend-api",
        input: {
          title: { kind: "node", node: "prepare", path: ["title"] },
          engine_version: { kind: "node", node: "prepare", path: ["engine_version"] },
          decision: { kind: "node", node: "await_approval", path: ["decision"] },
        },
        config: { method: "POST", path: "/api/v1/orders", body: { op: "input" } },
      },
    ],
    connections: [
      { from: "prepare", to: "await_approval" },
      { from: "await_approval", to: "create" },
    ],
  };
}

describe("M4-10 e2e: неизменяемые версии + pinning при публикации новой версии", () => {
  it("старый экземпляр завершается на своей версии; новая версия — только для новых стартов", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const runtime = createFbpRuntime({ backendClient: mock, now: fixedNow });

    // Публикуем v1 и запускаем экземпляр — он уходит в ожидание согласования.
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v1") });
    assert.equal(v1.version_no, 1);
    const oldInstance = await runtime.start({ organizationId: ORG, workflowId: "wf-orders", context, input: { title: "Заказ №1" } });
    assert.equal(oldInstance.status, "waiting");
    assert.equal(oldInstance.version_id, v1.id);

    // Admin публикует v2 (правка = НОВАЯ версия, не перезапись) и переключает default.
    const v2 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v2") });
    assert.equal(v2.version_no, 2);
    assert.notEqual(v1.id, v2.id);
    runtime.setDefaultVersion({ organizationId: ORG, workflowId: "wf-orders", versionId: v2.id });

    // Новый старт после публикации берёт v2 (default).
    const newInstance = await runtime.start({ organizationId: ORG, workflowId: "wf-orders", context, input: { title: "Заказ №2" } });
    assert.equal(newInstance.version_id, v2.id);

    // Старый экземпляр доигрывается — и делает это на ЗАКРЕПЛЁННОЙ v1.
    const oldDone = await runtime.resume({ organizationId: ORG, instanceId: oldInstance.instance_id, event: { decision: "approve" } });
    assert.equal(oldDone.status, "completed");
    assert.equal(oldDone.version_id, v1.id);
    assert.equal(oldDone.output.body.echo.engine_version, "v1", "старый экземпляр доигран на v1");

    // Новый экземпляр доигрывается на v2.
    const newDone = await runtime.resume({ organizationId: ORG, instanceId: newInstance.instance_id, event: { decision: "approve" } });
    assert.equal(newDone.status, "completed");
    assert.equal(newDone.output.body.echo.engine_version, "v2", "новый экземпляр доигран на v2");

    // Backend увидел оба заказа с их версиями (writesFor изолирует по арендатору).
    const writes = mock.writesFor(ORG);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((w) => w.body.engine_version).sort(),
      ["v1", "v2"],
    );
    // Каждый вызов Backend ушёл от имени этого арендатора (§13.5).
    assert.ok(mock.received.every((call) => call.organization_id === ORG));
  });

  it("попытка перезаписать существующую версию отклоняется (неизменяемость §13.10)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const runtime = createFbpRuntime({ backendClient: mock, now: fixedNow });
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v1") });

    assert.throws(
      () => runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("hacked"), versionNo: 1 }),
      (error) => error instanceof VersionImmutabilityError && error.reason === "version_immutable",
    );

    // v1 осталась неизменной, а её схема заморожена.
    const stored = runtime.versions.getVersion({ organizationId: ORG, workflowId: "wf-orders", versionId: v1.id });
    assert.equal(stored.schema.nodes[0].config.expression.args[1].value.engine_version, "v1");
    assert.throws(() => {
      stored.schema.nodes.push({ id: "x" });
    }, TypeError);
  });
});
