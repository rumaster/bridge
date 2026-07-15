import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime, createWorkflowMetrics } from "../../src/engine.js";

const ORG = "org-load";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;

/**
 * Кластер из K stateless-узлов поверх ОБЩИХ реестра версий, хранилища экземпляров
 * и коллектора метрик (в бою — Backend по C3, §25.3). Каждый узел — отдельный
 * `createFbpRuntime`; любой узел стартует любой экземпляр.
 *
 * Ревизия 2026-07-15: фазы «старт → ожидание → продолжение» больше нет —
 * исполнение сквозное. Под нагрузкой проверяется, что кластер доводит все
 * экземпляры до конца, метрики §24.6 сходятся и изоляция арендаторов не слабеет.
 */
function makeCluster({ nodeCount = 4 } = {}) {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const metrics = createWorkflowMetrics();
  const seed = createFbpRuntime({ backendClient: mock, metrics, now: fixedNow });
  const nodes = Array.from({ length: nodeCount }, () =>
    createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      metrics,
      now: fixedNow,
    }),
  );
  return { mock, seed, nodes, metrics };
}

/**
 * Схема нагрузочного пробника: событие → вызов Backend API, нагрузка события
 * уходит в тело запроса портом `body`. Узел transform сознательно не используется —
 * он исполняется в отдельном процессе-песочнице, и на N экземплярах пробник мерил
 * бы стоимость спавна процессов, а не масштабирование исполнителей.
 */
function loadSchema(workflowId: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: workflowId,
    nodes: [
      { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
      {
        id: "persist",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: { operation_id: POST_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
      },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "persist", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "persist", toPort: "body" },
    ],
  };
}

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

describe("Нагрузочный пробник: масштабирование stateless-исполнителей (ТЗ §25.3, §25.11)", () => {
  it("N экземпляров стартуют по round-robin на K узлах и все завершаются", async () => {
    const N = 24;
    const { seed, nodes, metrics } = makeCluster({ nodeCount: 4 });
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema: loadSchema("wf-load") });

    const instanceIds = new Set<string>();
    for (let i = 0; i < N; i += 1) {
      const node = nodes[i % nodes.length];
      const res = await node.start({
        organizationId: ORG,
        workflowId: "wf-load",
        context,
        input: { name: `u${i}` },
        startNodeId: "evt",
      });
      assert.equal(res.status, "completed", `экземпляр ${i} должен завершиться`);
      assert.equal(res.output.response.body.echo.name, `u${i}`, `экземпляр ${i} обработал свою нагрузку`);
      instanceIds.add(res.instance_id);
    }
    assert.equal(instanceIds.size, N, "экземпляры не схлопнулись в один id");

    // Итог §24.6: N запусков, N успехов, 0 ошибок, 0 активных.
    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, N);
    assert.equal(snap.total.successes, N);
    assert.equal(snap.total.errors, 0);
    assert.equal(snap.total.active, 0, "после завершения активных не остаётся");

    const wf = snap.workflows.find((w: any) => w.workflow_id === "wf-load");
    assert.equal(wf.runs, N);
    assert.equal(wf.successes, N);
  });

  it("узел, поднятый ПОСЛЕ старта остальных, обслуживает экземпляры без общей памяти", async () => {
    const { mock, seed, nodes, metrics } = makeCluster({ nodeCount: 2 });
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema: loadSchema("wf-load") });

    await nodes[0].start({
      organizationId: ORG,
      workflowId: "wf-load",
      context,
      input: { name: "первый" },
      startNodeId: "evt",
    });

    // Совершенно НОВЫЙ рантайм поверх того же хранилища: ему не нужна ни память
    // стартовавшего узла, ни «прогрев» — версия и экземпляры лежат в общем store.
    const freshNode = createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      metrics,
      now: fixedNow,
    });
    const res = await freshNode.start({
      organizationId: ORG,
      workflowId: "wf-load",
      context,
      input: { name: "свежий" },
      startNodeId: "evt",
    });
    assert.equal(res.status, "completed");
    assert.equal(res.output.response.body.echo.name, "свежий");

    const snap = metrics.snapshot();
    assert.equal(snap.total.successes, 2);
    assert.equal(snap.total.active, 0);
  });

  it("нагрузка не ослабляет изоляцию арендаторов: параллельные org не видят друг друга", async () => {
    const { seed, nodes } = makeCluster({ nodeCount: 3 });
    seed.publishVersion({ organizationId: "org-x", workflowId: "wf-load", schema: loadSchema("wf-load") });
    seed.publishVersion({ organizationId: "org-y", workflowId: "wf-load", schema: loadSchema("wf-load") });

    const ctxX = { organization_id: "org-x", actor_user_id: "ux", trigger: "manual" };
    const ctxY = { organization_id: "org-y", actor_user_id: "uy", trigger: "manual" };

    // Чередуем старты двух арендаторов на разных узлах.
    for (let i = 0; i < 10; i += 1) {
      const useX = i % 2 === 0;
      const org = useX ? "org-x" : "org-y";
      const name = useX ? `x${i}` : `y${i}`;
      const res = await nodes[i % nodes.length].start({
        organizationId: org,
        workflowId: "wf-load",
        context: useX ? ctxX : ctxY,
        input: { name },
        startNodeId: "evt",
      });

      assert.equal(res.status, "completed");
      assert.equal(res.organization_id, org, "экземпляр завершился строго в своём арендаторе");
      assert.equal(res.output.response.body.echo.name, name);
      assert.equal(res.output.response.body.organization_id, org, "Backend ответил в пределах арендатора");
    }
  });
});
