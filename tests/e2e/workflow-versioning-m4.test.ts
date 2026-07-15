import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.js";
import { createFbpRuntime } from "../../services/fbp-engine/src/engine.js";
import { VersionImmutabilityError } from "../../services/fbp-engine/src/core/errors.js";

/**
 * e2e вехи M4-10 (SVC-FBP): неизменяемые версии и version pinning — на РЕАЛЬНОМ
 * рантайме движка без Docker/БД.
 *
 * Контрольный сценарий: экземпляр исполняется на ЗАКРЕПЛЁННОЙ версии; публикация
 * новой версии и переключение default влияют только на последующие старты
 * (ТЗ §13.10).
 *
 * Ревизия 2026-07-15: точки ожидания посреди схемы больше нет — исполнение
 * сквозное, поэтому «стартовал до публикации, доиграл после» выражается через
 * явное закрепление версии (`versionId`), а не через паузу между шагами.
 */

const ORG = "10000000-0000-4000-8000-0000000000a1";
const fixedNow = () => "2026-07-04T00:00:00.000Z";
const context = { organization_id: ORG, actor_user_id: "manager-a", trigger: "manual" };

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;

/** Маркер версии зашит в код transform — по записи в Backend видно, чья схема отработала. */
function approvalSchema(marker: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-orders",
    nodes: [
      { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
      {
        id: "prepare",
        type: "transform",
        position: { x: 0, y: 0 },
        config: {
          code: `return { title: input.event.title, engine_version: ${JSON.stringify(marker)} };`,
          inputs: [{ name: "event", type: "object" }],
          outputs: [{ name: "payload", type: "object" }],
        },
      },
      {
        id: "create",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: { operation_id: POST_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
      },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "prepare", toPort: "event" },
      { id: "c3", from: "prepare", fromPort: "payload", to: "create", toPort: "body" },
    ],
  };
}

function makeRuntime() {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const runtime = createFbpRuntime({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
  return { mock, runtime };
}

function start(runtime: any, title: string, versionId?: string) {
  return runtime.start({
    organizationId: ORG,
    workflowId: "wf-orders",
    context,
    input: { title },
    startNodeId: "evt",
    ...(versionId ? { versionId } : {}),
  });
}

describe("M4-10 e2e: неизменяемые версии + pinning при публикации новой версии", () => {
  it("публикация новой версии не влияет на закреплённую: v1 доигрывает на v1, новые старты идут на v2", async () => {
    const { mock, runtime } = makeRuntime();

    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v1") });
    assert.equal(v1.version_no, 1);
    const onV1 = await start(runtime, "Заказ №1");
    assert.equal(onV1.status, "completed");
    assert.equal(onV1.version_id, v1.id);
    assert.equal(onV1.output.response.body.echo.engine_version, "v1");

    // Admin публикует v2 (правка = НОВАЯ версия, не перезапись) и переключает default.
    const v2 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v2") });
    assert.equal(v2.version_no, 2);
    assert.notEqual(v1.id, v2.id);
    runtime.setDefaultVersion({ organizationId: ORG, workflowId: "wf-orders", versionId: v2.id });

    // Новый старт после публикации берёт v2 (default).
    const onDefault = await start(runtime, "Заказ №2");
    assert.equal(onDefault.version_id, v2.id);
    assert.equal(onDefault.output.response.body.echo.engine_version, "v2");

    // Экземпляр, закреплённый за v1, исполняется на v1 ДАЖЕ после переключения default.
    const pinnedToV1 = await start(runtime, "Заказ №3", v1.id);
    assert.equal(pinnedToV1.version_id, v1.id);
    assert.equal(pinnedToV1.output.response.body.echo.engine_version, "v1", "закреплённая версия не подменяется новой");

    // Уже созданный экземпляр остался закреплён за своей версией в хранилище.
    const stored = runtime.instances.getInstance({ organizationId: ORG, instanceId: onV1.instance_id });
    assert.equal(stored.version_id, v1.id);

    // Backend увидел все три заказа с их версиями (writesFor изолирует по арендатору).
    const writes = mock.writesFor(ORG);
    assert.equal(writes.length, 3);
    assert.deepEqual(
      writes.map((w: any) => w.body.engine_version).sort(),
      ["v1", "v1", "v2"],
    );
    // Каждый вызов Backend ушёл от имени этого арендатора (§13.5).
    assert.ok(mock.received.every((call: any) => call.organization_id === ORG));
  });

  it("попытка перезаписать существующую версию отклоняется (неизменяемость §13.10)", async () => {
    const { runtime } = makeRuntime();
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-orders", schema: approvalSchema("v1") });

    assert.throws(
      () =>
        runtime.publishVersion({
          organizationId: ORG,
          workflowId: "wf-orders",
          schema: approvalSchema("hacked"),
          versionNo: 1,
        }),
      (error) => error instanceof VersionImmutabilityError && error.reason === "version_immutable",
    );

    // v1 осталась неизменной, а её схема заморожена.
    const stored = runtime.versions.getVersion({ organizationId: ORG, workflowId: "wf-orders", versionId: v1.id });
    const prepare = stored.schema.nodes.find((node: any) => node.id === "prepare");
    assert.match(prepare.config.code, /"v1"/);
    assert.throws(() => {
      stored.schema.nodes.push({ id: "x" });
    }, TypeError);
  });
});
