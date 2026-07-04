import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../src/backend/client.mjs";
import { createFbpRuntime } from "../../src/engine.mjs";
import { WorkflowStoreError } from "../../src/core/errors.mjs";

const ORG = "org-a";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

// Схема: wait-event → transform → backend-api. После ожидания исполнитель обязан
// восстановить результаты уже исполненных узлов из внешнего состояния.
function waitingSchema() {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-1",
    entry: "prepare",
    nodes: [
      {
        id: "prepare",
        type: "transform",
        input: { title: { kind: "params", path: ["title"] } },
        config: { expression: { op: "input" } },
      },
      { id: "gate", type: "wait-event", config: { event_type: "approved" } },
      {
        id: "persist",
        type: "backend-api",
        input: {
          title: { kind: "node", node: "prepare", path: ["title"] },
          decision: { kind: "node", node: "gate", path: ["decision"] },
        },
        config: { method: "POST", path: "/api/v1/decisions", body: { op: "input" } },
      },
    ],
    connections: [
      { from: "prepare", to: "gate" },
      { from: "gate", to: "persist" },
    ],
  };
}

function makeRuntime() {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const runtime = createFbpRuntime({ backendClient: mock, now: fixedNow });
  return { mock, runtime };
}

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

describe("Runtime: version pinning — привязка версии к экземпляру (ТЗ §13.10)", () => {
  it("экземпляр закрепляется за версией по умолчанию на старте", async () => {
    const { runtime } = makeRuntime();
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });

    const started = await runtime.start({ organizationId: ORG, workflowId: "wf-1", context, input: { title: "T" } });
    assert.equal(started.status, "waiting");
    assert.equal(started.version_id, v1.id);

    const instance = runtime.instances.getInstance({ organizationId: ORG, instanceId: started.instance_id });
    assert.equal(instance.version_id, v1.id);
    assert.equal(instance.status, "waiting");
  });

  it("явно заданная versionId закрепляется вместо версии по умолчанию", async () => {
    const { runtime } = makeRuntime();
    const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });
    const v2 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });
    runtime.setDefaultVersion({ organizationId: ORG, workflowId: "wf-1", versionId: v2.id });

    const started = await runtime.start({
      organizationId: ORG,
      workflowId: "wf-1",
      context,
      input: { title: "T" },
      versionId: v1.id,
    });
    assert.equal(started.version_id, v1.id);
    assert.notEqual(started.version_id, v2.id);
  });
});

describe("Runtime: восстановление шага из внешнего состояния (ТЗ §25.3)", () => {
  it("resume поднимает результаты ранее исполненных узлов из workflow_instance_state", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });

    const started = await runtime.start({ organizationId: ORG, workflowId: "wf-1", context, input: { title: "Заявка" } });
    assert.equal(started.status, "waiting");
    assert.equal(started.waiting_node_id, "gate");

    // Внешнее состояние содержит снимок: результат уже исполненного `prepare`.
    const snapshot = runtime.instances.loadState({ organizationId: ORG, instanceId: started.instance_id });
    assert.deepEqual(snapshot.outputs.prepare, { title: "Заявка" });
    assert.equal(snapshot.cursor.waiting_node_id, "gate");

    const resumed = await runtime.resume({
      organizationId: ORG,
      instanceId: started.instance_id,
      event: { decision: "approve" },
    });
    assert.equal(resumed.status, "completed");
    // Узел persist получил и восстановленный `prepare.title`, и данные события.
    assert.deepEqual(resumed.output.body.echo, { title: "Заявка", decision: "approve" });
    // Порядковый номер журнала продолжился без коллизий id.
    const ids = new Set(resumed.journal.map((entry) => entry.id));
    assert.equal(ids.size, resumed.journal.length);
  });

  it("после завершения внешнее состояние очищается", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });
    const started = await runtime.start({ organizationId: ORG, workflowId: "wf-1", context, input: { title: "T" } });
    await runtime.resume({ organizationId: ORG, instanceId: started.instance_id, event: { decision: "ok" } });
    assert.equal(runtime.instances.loadState({ organizationId: ORG, instanceId: started.instance_id }), null);
    const instance = runtime.instances.getInstance({ organizationId: ORG, instanceId: started.instance_id });
    assert.equal(instance.status, "completed");
  });

  it("resume отклоняется для экземпляра не в ожидании", async () => {
    const { runtime } = makeRuntime();
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: waitingSchema() });
    const started = await runtime.start({ organizationId: ORG, workflowId: "wf-1", context, input: { title: "T" } });
    await runtime.resume({ organizationId: ORG, instanceId: started.instance_id, event: { decision: "ok" } });
    await assert.rejects(
      () => runtime.resume({ organizationId: ORG, instanceId: started.instance_id, event: {} }),
      (error) => error instanceof WorkflowStoreError && error.reason === "instance_not_waiting",
    );
  });
});
