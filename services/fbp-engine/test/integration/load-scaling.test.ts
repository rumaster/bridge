import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime, createWorkflowMetrics } from "../../src/engine.js";

const ORG = "org-load";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

// Кластер из K stateless-узлов поверх ОБЩИХ реестра версий, хранилища состояния и
// коллектора метрик (в бою — Backend по C3, §25.3). Каждый узел — отдельный
// `createFbpRuntime`; любой узел обрабатывает любой экземпляр по внешнему состоянию.
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

function twoStepSchema(marker) {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-load",
    entry: "prepare",
    nodes: [
      {
        id: "prepare",
        type: "transform",
        input: { name: { kind: "params", path: ["name"] } },
        config: { expression: { op: "merge", args: [{ op: "input" }, { op: "lit", value: { version: marker } }] } },
      },
      { id: "gate", type: "wait-event", config: { event_type: "approved" } },
      {
        id: "persist",
        type: "backend-api",
        input: {
          name: { kind: "node", node: "prepare", path: ["name"] },
          decision: { kind: "node", node: "gate", path: ["decision"] },
        },
        config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
      },
    ],
    connections: [
      { from: "prepare", fromPort: "out", to: "gate", toPort: "in" },
      { from: "gate", fromPort: "out", to: "persist", toPort: "in" },
    ],
  };
}

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

describe("Нагрузочный пробник: масштабирование stateless-исполнителей (ТЗ §25.3, §25.11)", () => {
  it("N экземпляров стартуют и продолжаются по round-robin на K узлах, все завершаются", async () => {
    const N = 24;
    const { seed, nodes, metrics } = makeCluster({ nodeCount: 4 });
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema: twoStepSchema("v1") });

    // Фаза старта: каждый экземпляр стартует на «своём» узле (round-robin) и уходит
    // в ожидание — состояние externalized в общее хранилище.
    const started = [];
    for (let i = 0; i < N; i += 1) {
      const node = nodes[i % nodes.length];
      const res = await node.start({ organizationId: ORG, workflowId: "wf-load", context, input: { name: `u${i}` } });
      assert.equal(res.status, "waiting", `экземпляр ${i} должен уйти в ожидание`);
      started.push(res);
    }

    // Пока все в ожидании — они АКТИВНЫ (§24.6): waiting не терминален.
    let snap = metrics.snapshot();
    assert.equal(snap.total.runs, N);
    assert.equal(snap.total.active, N, "все экземпляры активны, пока ждут события");
    assert.equal(snap.total.successes, 0);

    // Фаза продолжения: КАЖДЫЙ экземпляр продолжает ДРУГОЙ узел (сдвиг round-robin),
    // моделируя перебалансировку нагрузки между исполнителями.
    for (let i = 0; i < started.length; i += 1) {
      const node = nodes[(i + 2) % nodes.length];
      const res = await node.resume({ organizationId: ORG, instanceId: started[i].instance_id, event: { decision: "ok" } });
      assert.equal(res.status, "completed", `экземпляр ${i} должен завершиться`);
      assert.equal(res.output.body.echo.name, `u${i}`);
    }

    // Итог §24.6: N запусков, N успехов, 0 ошибок, 0 активных.
    snap = metrics.snapshot();
    assert.equal(snap.total.runs, N);
    assert.equal(snap.total.successes, N);
    assert.equal(snap.total.errors, 0);
    assert.equal(snap.total.active, 0, "после завершения активных не остаётся");

    const wf = snap.workflows.find((w) => w.workflow_id === "wf-load");
    assert.equal(wf.runs, N);
    assert.equal(wf.successes, N);
  });

  it("восстановление stateless: экземпляр доигрывается на СВЕЖЕМ узле без общей памяти", async () => {
    const { mock, seed, nodes, metrics } = makeCluster({ nodeCount: 2 });
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema: twoStepSchema("v1") });

    // Стартовавший узел «падает» — просто перестаём его использовать.
    const started = await nodes[0].start({ organizationId: ORG, workflowId: "wf-load", context, input: { name: "recover" } });
    assert.equal(started.status, "waiting");

    // Совершенно НОВЫЙ рантайм (новый узел-исполнитель), поднятый поверх того же
    // хранилища, доводит экземпляр до конца — исполнителю не нужна память между шагами.
    const freshNode = createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      metrics,
      now: fixedNow,
    });
    const resumed = await freshNode.resume({ organizationId: ORG, instanceId: started.instance_id, event: { decision: "yes" } });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.output.body.echo.name, "recover");

    const snap = metrics.snapshot();
    assert.equal(snap.total.successes, 1);
    assert.equal(snap.total.active, 0);
  });

  it("нагрузка не ослабляет изоляцию арендаторов: параллельные org не видят друг друга", async () => {
    const { seed, nodes } = makeCluster({ nodeCount: 3 });
    seed.publishVersion({ organizationId: "org-x", workflowId: "wf-load", schema: twoStepSchema("v1") });
    seed.publishVersion({ organizationId: "org-y", workflowId: "wf-load", schema: twoStepSchema("v1") });

    const ctxX = { organization_id: "org-x", actor_user_id: "ux", trigger: "manual" };
    const ctxY = { organization_id: "org-y", actor_user_id: "uy", trigger: "manual" };

    // Чередуем старты двух арендаторов на разных узлах.
    const handles = [];
    for (let i = 0; i < 10; i += 1) {
      const useX = i % 2 === 0;
      const node = nodes[i % nodes.length];
      const res = await node.start({
        organizationId: useX ? "org-x" : "org-y",
        workflowId: "wf-load",
        context: useX ? ctxX : ctxY,
        input: { name: useX ? `x${i}` : `y${i}` },
      });
      handles.push({ org: useX ? "org-x" : "org-y", id: res.instance_id, name: useX ? `x${i}` : `y${i}` });
    }

    for (let i = 0; i < handles.length; i += 1) {
      const h = handles[i];
      const node = nodes[(i + 1) % nodes.length];
      const res = await node.resume({ organizationId: h.org, instanceId: h.id, event: { decision: "ok" } });
      assert.equal(res.status, "completed");
      assert.equal(res.organization_id, h.org, "экземпляр завершился строго в своём арендаторе");
      assert.equal(res.output.body.echo.name, h.name);
      assert.equal(res.output.body.organization_id, h.org, "Backend ответил в пределах арендатора");
    }
  });
});
