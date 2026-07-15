import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime } from "../../src/engine.js";
import { WorkflowStoreError } from "../../src/core/errors.js";

const ORG = "org-a";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;
assert.ok(POST_OP, "в каталоге Backend API нужна POST-операция без плейсхолдеров");

/**
 * Схема 2.0: событие → (лениво) transform с маркером версии → вызов Backend API.
 * Маркер вшит в код transform, поэтому по ответу Backend видно, ЧЬЯ версия схемы
 * реально исполнилась, — на этом держатся проверки version pinning.
 */
function markerSchema(marker: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-1",
    nodes: [
      { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
      {
        id: "mark",
        type: "transform",
        position: { x: 0, y: 0 },
        config: {
          code: `return { version: ${JSON.stringify(marker)}, name: input.event.name };`,
          inputs: [{ name: "event", type: "object" }],
          outputs: [
            { name: "version", type: "string", path: "result.version" },
            { name: "name", type: "string", path: "result.name" },
          ],
        },
      },
      {
        id: "persist",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: {
          operation_id: POST_OP.operation_id,
          inputs: [
            { name: "version", type: "string" },
            { name: "name", type: "string" },
          ],
        },
      },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "persist", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "mark", toPort: "event" },
      { id: "c3", from: "mark", fromPort: "version", to: "persist", toPort: "version" },
      { id: "c4", from: "mark", fromPort: "name", to: "persist", toPort: "name" },
    ],
  };
}

/** Схема, гарантированно падающая на исполнении: transform бросает. */
function failingSchema() {
  const schema = markerSchema("v1");
  schema.nodes[1].config.code = "throw new Error('умышленный сбой');";
  return schema;
}

function makeRuntime() {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  // Таймаут песочницы поднят: узел transform исполняется в отдельном процессе, и
  // дефолтные 200 мс на холодном старте процесса дают ложные падения.
  const runtime = createFbpRuntime({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
  return { mock, runtime };
}

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

function start(runtime: any, overrides: Record<string, unknown> = {}) {
  return runtime.start({
    organizationId: ORG,
    workflowId: "wf-1",
    context,
    input: { name: "Иван" },
    startNodeId: "evt",
    ...overrides,
  });
}

describe("Runtime: version pinning — привязка версии к экземпляру (ТЗ §13.10)", () => {
  it("экземпляр закрепляется за версией по умолчанию на старте", async () => {
    const { runtime } = makeRuntime();
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const started = await start(runtime);
    assert.equal(started.status, "completed");
    assert.equal(started.version_id, v1.id);

    const instance = runtime.instances.getInstance({ organizationId: ORG, instanceId: started.instance_id });
    assert.equal(instance.version_id, v1.id);
    assert.equal(instance.status, "completed");
    assert.equal(instance.finished_at, fixedNow());
  });

  it("явно заданная versionId закрепляется вместо версии по умолчанию", async () => {
    const { runtime } = makeRuntime();
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    const v2 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v2") });
    runtime.setDefaultVersion({ organizationId: ORG, workflowId: "wf-1", versionId: v2.id });

    const started = await start(runtime, { versionId: v1.id });
    assert.equal(started.version_id, v1.id);
    assert.notEqual(started.version_id, v2.id);
    // Исполнилась именно ЗАКРЕПЛЁННАЯ схема, а не версия по умолчанию.
    assert.equal(started.output.response.body.echo.version, "v1");
  });
});

describe("Runtime: старт только с узла «Ожидание события» (Ревизия 2026-07-15)", () => {
  it("исполняет схему с указанного узла события и отдаёт его нагрузку дальше", async () => {
    const { runtime, mock } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const result = await start(runtime, { input: { name: "Пётр" } });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.output.response.body.echo, { version: "v1", name: "Пётр" });
    assert.equal(mock.received[0].organization_id, ORG, "вызов Backend ушёл от имени арендатора экземпляра");
  });

  it("start требует start_node_id — без узла события запускать нечего", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    await assert.rejects(
      () => start(runtime, { startNodeId: undefined }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_argument",
    );
  });

  it("start требует organization_id — инициатор Workflow всегда Backend (§6.13)", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    await assert.rejects(
      () => runtime.start({ workflowId: "wf-1", context: {}, startNodeId: "evt" }),
      (error: any) => error.reason === "invalid_context",
    );
  });

  it("старт с узла, который не является событием, завершает экземпляр ошибкой", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const result = await start(runtime, { startNodeId: "persist" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.reason, "invalid_start_node");
    const instance = runtime.instances.getInstance({ organizationId: ORG, instanceId: result.instance_id });
    assert.equal(instance.status, "failed");
  });
});

describe("Runtime: детерминизм instance_id", () => {
  it("одинаковые арендатор/схема/версия/вход дают одинаковый instance_id на разных рантаймах", async () => {
    const a = makeRuntime().runtime;
    const b = makeRuntime().runtime;
    a.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    b.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const first = await start(a, { input: { name: "Иван", age: 30 } });
    // Порядок ключей входа не влияет: сериализация сортирует ключи (без ГСЧ и времени).
    const second = await start(b, { input: { age: 30, name: "Иван" } });
    assert.equal(first.instance_id, second.instance_id);
  });

  it("разный вход даёт разные экземпляры", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    const first = await start(runtime, { input: { name: "Иван" } });
    const second = await start(runtime, { input: { name: "Пётр" } });
    assert.notEqual(first.instance_id, second.instance_id);
  });

  it("арендаторы не делят instance_id при одинаковом входе", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    runtime.publishVersion({ organizationId: "org-b", workflowId: "wf-1", schema: markerSchema("v1") });

    const mine = await start(runtime);
    const theirs = await runtime.start({
      organizationId: "org-b",
      workflowId: "wf-1",
      context: { organization_id: "org-b" },
      input: { name: "Иван" },
      startNodeId: "evt",
    });
    assert.notEqual(mine.instance_id, theirs.instance_id);
  });
});

describe("Runtime: сбой исполнения (ТЗ §13.9)", () => {
  it("падение узла даёт status=failed, журнал возвращается всегда", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: failingSchema() });

    const result = await start(runtime);
    assert.equal(result.status, "failed");
    assert.equal(result.output, null);
    assert.equal(result.error.node_id, "mark");
    assert.equal(result.error.node_type, "transform");
    // Журнал уходит в workflow_execution_logs — Backend обязан его получить даже при сбое.
    assert.ok(result.journal.some((entry: any) => entry.event === "workflow.failed"));
    assert.ok(result.journal.some((entry: any) => entry.event === "node.failed" && entry.node_id === "mark"));

    const instance = runtime.instances.getInstance({ organizationId: ORG, instanceId: result.instance_id });
    assert.equal(instance.status, "failed");
  });
});

describe("Runtime: метрики §24.6", () => {
  it("успешный экземпляр: один запуск, один успех, активных не осталось", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });
    await start(runtime);

    const snap = runtime.getMetrics();
    assert.equal(snap.total.runs, 1);
    assert.equal(snap.total.successes, 1);
    assert.equal(snap.total.errors, 0);
    assert.equal(snap.total.active, 0, "завершённый экземпляр активным не остаётся");
    assert.equal(snap.workflows.find((w: any) => w.workflow_id === "wf-1").runs, 1);
  });

  it("упавший экземпляр учитывается как ошибка, а не как успех", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: failingSchema() });
    await start(runtime);

    const snap = runtime.getMetrics();
    assert.equal(snap.total.runs, 1);
    assert.equal(snap.total.successes, 0);
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.active, 0);
  });
});
