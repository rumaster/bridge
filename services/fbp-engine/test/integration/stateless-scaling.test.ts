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

/**
 * Ревизия 2026-07-15: `resume` и снимки в `workflow_instance_state` удалены —
 * исполнение стало сквозным, между шагами хранить нечего, и прежний сценарий
 * «узел A довёл до ожидания, узел B продолжил» смысла больше не имеет.
 *
 * Что от §25.3 осталось проверять: узлы-исполнители не держат состояния САМИ —
 * источником правды остаётся общее хранилище (в бою — Backend по C3). Поэтому
 * любой узел кластера стартует любой экземпляр, закреплённая версия соблюдается
 * независимо от узла, а детерминированный instance_id не даёт двум узлам завести
 * дубль одного экземпляра.
 *
 * Общий кластер: реестр версий и хранилище экземпляров разделяются между узлами;
 * каждый `createFbpRuntime` поверх них моделирует ОТДЕЛЬНЫЙ stateless-узел.
 */
function makeCluster() {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const seed = createFbpRuntime({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
  const node = () =>
    createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      now: fixedNow,
      limits: { codeTimeoutMs: 5000 },
    });
  return { mock, seed, node };
}

/** Маркер версии вшит в transform — по ответу Backend видно, чья схема исполнилась. */
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

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

function start(runtime: any, name: string) {
  return runtime.start({
    organizationId: ORG,
    workflowId: "wf-1",
    context,
    input: { name },
    startNodeId: "evt",
  });
}

describe("Stateless executor: узлы кластера не держат состояния сами (ТЗ §25.3)", () => {
  it("схема, опубликованная на одном узле, исполняется другим — без общей памяти", async () => {
    const { seed, node } = makeCluster();
    // Публикует ОДИН узел, исполняет СОВЕРШЕННО ДРУГОЙ: версия берётся из общего
    // реестра, а не из памяти опубликовавшего.
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const result = await start(node(), "Иван");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.output.response.body.echo, { version: "v1", name: "Иван" });
  });

  it("два разных узла исполняют одну схему одинаково", async () => {
    const { seed, node } = makeCluster();
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const fromA = await start(node(), "A");
    const fromB = await start(node(), "B");

    assert.equal(fromA.status, "completed");
    assert.equal(fromB.status, "completed");
    assert.equal(fromA.version_id, fromB.version_id, "оба узла закрепили одну и ту же версию");
    assert.deepEqual(fromA.output.response.body.echo, { version: "v1", name: "A" });
    assert.deepEqual(fromB.output.response.body.echo, { version: "v1", name: "B" });
  });

  it("экземпляр, заведённый одним узлом, виден другому через общее хранилище", async () => {
    const { seed, node } = makeCluster();
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const started = await start(node(), "Иван");
    // Другой узел читает экземпляр по идентификатору — память стартовавшего узла не нужна.
    const seenByOther = node().instances.getInstance({ organizationId: ORG, instanceId: started.instance_id });
    assert.equal(seenByOther.status, "completed");
    assert.equal(seenByOther.version_id, started.version_id);
  });

  it("детерминированный instance_id не даёт двум узлам завести дубль экземпляра", async () => {
    const { seed, node } = makeCluster();
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    await start(node(), "Иван");
    // Тот же арендатор/схема/версия/вход на ДРУГОМ узле → тот же instance_id, и
    // общее хранилище отвергает повторное создание: защита от дублей — в store,
    // а не в памяти узла.
    await assert.rejects(
      () => start(node(), "Иван"),
      (error) => error instanceof WorkflowStoreError && error.reason === "instance_exists",
    );
  });
});

describe("Version pinning совместим с масштабированием (ТЗ §13.10, §25.3)", () => {
  it("переключение default между узлами не трогает закреплённую версию идущих запусков", async () => {
    const { seed, node } = makeCluster();
    const v1 = seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v1") });

    const onV1 = await start(node(), "Иван");
    assert.equal(onV1.version_id, v1.id);
    assert.equal(onV1.output.response.body.echo.version, "v1");

    // Публикуется v2 и делается версией по умолчанию — на другом узле кластера.
    const v2 = seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: markerSchema("v2") });
    seed.setDefaultVersion({ organizationId: ORG, workflowId: "wf-1", versionId: v2.id });

    // Явно закреплённая v1 доигрывается на v1, даже если default уже v2.
    const pinned = await node().start({
      organizationId: ORG,
      workflowId: "wf-1",
      context,
      input: { name: "Пётр" },
      startNodeId: "evt",
      versionId: v1.id,
    });
    assert.equal(pinned.version_id, v1.id);
    assert.equal(pinned.output.response.body.echo.version, "v1", "закреплённая версия не подменяется новой");

    // А новый старт без явной версии уходит уже на v2 — на любом узле кластера.
    const fresh = await start(node(), "Мария");
    assert.equal(fresh.version_id, v2.id);
    assert.equal(fresh.output.response.body.echo.version, "v2");

    // Уже созданный экземпляр остался закреплён за своей версией.
    const stored = node().instances.getInstance({ organizationId: ORG, instanceId: onV1.instance_id });
    assert.equal(stored.version_id, v1.id);
  });
});
