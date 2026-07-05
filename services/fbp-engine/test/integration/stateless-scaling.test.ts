import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime } from "../../src/engine.js";

const ORG = "org-a";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

// Общий кластер: реестр версий и хранилище экземпляров/состояния разделяются
// между узлами-исполнителями (в бою — Backend по C3). Каждый `createFbpRuntime`
// поверх этого хранилища моделирует ОТДЕЛЬНЫЙ stateless-узел (ТЗ §25.3).
function makeCluster() {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const seed = createFbpRuntime({ backendClient: mock, now: fixedNow });
  const node = () =>
    createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      now: fixedNow,
    });
  return { mock, seed, node };
}

function twoStepSchema(marker) {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-1",
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
          version: { kind: "node", node: "prepare", path: ["version"] },
          decision: { kind: "node", node: "gate", path: ["decision"] },
        },
        config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
      },
    ],
    connections: [
      { from: "prepare", to: "gate" },
      { from: "gate", to: "persist" },
    ],
  };
}

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

describe("Stateless executor: продолжение экземпляра другим узлом (ТЗ §25.3)", () => {
  it("узел A стартует до ожидания, узел B продолжает по workflow_instance_state", async () => {
    const { seed, node } = makeCluster();
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: twoStepSchema("v1") });

    // Узел A: старт → ожидание. Состояние externalized в хранилище.
    const nodeA = node();
    const started = await nodeA.start({ organizationId: ORG, workflowId: "wf-1", context, input: { name: "Иван" } });
    assert.equal(started.status, "waiting");

    // Узел B — совершенно другой инстанс исполнителя без общей памяти с A —
    // поднимает состояние из хранилища и доводит экземпляр до конца.
    const nodeB = node();
    const resumed = await nodeB.resume({
      organizationId: ORG,
      instanceId: started.instance_id,
      event: { decision: "approve" },
    });

    assert.equal(resumed.status, "completed");
    // persist получил результат `prepare`, исполненного ЕЩЁ на узле A.
    assert.deepEqual(resumed.output.body.echo, { name: "Иван", version: "v1", decision: "approve" });
  });

  it("несколько экземпляров можно продолжать на разных узлах в разном порядке", async () => {
    const { seed, node } = makeCluster();
    seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: twoStepSchema("v1") });

    const nodeA = node();
    const i1 = await nodeA.start({ organizationId: ORG, workflowId: "wf-1", context, input: { name: "A" } });
    const i2 = await nodeA.start({ organizationId: ORG, workflowId: "wf-1", context, input: { name: "B" } });
    assert.notEqual(i1.instance_id, i2.instance_id);

    // Продолжаем во «встречном» порядке на разных узлах.
    const r2 = await node().resume({ organizationId: ORG, instanceId: i2.instance_id, event: { decision: "no" } });
    const r1 = await node().resume({ organizationId: ORG, instanceId: i1.instance_id, event: { decision: "yes" } });

    assert.equal(r1.output.body.echo.name, "A");
    assert.equal(r1.output.body.echo.decision, "yes");
    assert.equal(r2.output.body.echo.name, "B");
    assert.equal(r2.output.body.echo.decision, "no");
  });
});

describe("Version pinning совместим с масштабированием (ТЗ §13.10, §25.3)", () => {
  it("экземпляр завершается на своей версии, даже если default переключён между узлами", async () => {
    const { seed, node } = makeCluster();
    const v1 = seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: twoStepSchema("v1") });

    // Узел A стартует на v1 → ожидание.
    const started = await node().start({ organizationId: ORG, workflowId: "wf-1", context, input: { name: "Иван" } });
    assert.equal(started.version_id, v1.id);

    // Между шагами публикуется v2 и делается версией по умолчанию.
    const v2 = seed.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: twoStepSchema("v2") });
    seed.setDefaultVersion({ organizationId: ORG, workflowId: "wf-1", versionId: v2.id });

    // Узел B продолжает — ДОЛЖЕН доиграть на ЗАКРЕПЛЁННОЙ v1, а не на новой v2.
    const resumed = await node().resume({
      organizationId: ORG,
      instanceId: started.instance_id,
      event: { decision: "approve" },
    });
    assert.equal(resumed.version_id, v1.id);
    assert.equal(resumed.output.body.echo.version, "v1", "экземпляр доигран на закреплённой версии");

    // А НОВЫЙ старт уходит уже на v2 (default), не затрагивая идущий экземпляр.
    const fresh = await node().start({ organizationId: ORG, workflowId: "wf-1", context, input: { name: "Пётр" } });
    assert.equal(fresh.version_id, v2.id);
    const freshResumed = await node().resume({
      organizationId: ORG,
      instanceId: fresh.instance_id,
      event: { decision: "ok" },
    });
    assert.equal(freshResumed.output.body.echo.version, "v2");
  });
});
