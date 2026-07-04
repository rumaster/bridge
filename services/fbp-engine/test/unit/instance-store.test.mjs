import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInstanceStore } from "../../src/state/instance-store.mjs";
import { WorkflowStoreError } from "../../src/core/errors.mjs";

const ORG_A = "org-a";
const ORG_B = "org-b";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

function makeStore() {
  return createInstanceStore({ now: fixedNow });
}

const baseInstance = {
  organizationId: ORG_A,
  workflowId: "wf-1",
  versionId: "ver-1",
  instanceId: "inst-1",
};

describe("Хранилище экземпляров: version pinning (ТЗ §13.10)", () => {
  it("экземпляр закрепляется за версией и связь неизменна", () => {
    const store = makeStore();
    const created = store.createInstance({ ...baseInstance, status: "running" });
    assert.equal(created.version_id, "ver-1");

    // updateInstance меняет только статус/метки, но не version_id.
    store.updateInstance({ organizationId: ORG_A, instanceId: "inst-1", status: "waiting", version_id: "ver-2" });
    assert.equal(store.getInstance({ organizationId: ORG_A, instanceId: "inst-1" }).version_id, "ver-1");
  });

  it("повторное создание того же экземпляра запрещено", () => {
    const store = makeStore();
    store.createInstance(baseInstance);
    assert.throws(
      () => store.createInstance(baseInstance),
      (error) => error instanceof WorkflowStoreError && error.reason === "instance_exists",
    );
  });

  it("недопустимый статус отклоняется", () => {
    const store = makeStore();
    assert.throws(
      () => store.createInstance({ ...baseInstance, status: "bogus" }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_argument",
    );
  });
});

describe("Хранилище состояния: workflow_instance_state (ТЗ §25.3)", () => {
  it("saveState/loadState хранит снимок вне исполнителя (глубокая копия)", () => {
    const store = makeStore();
    store.createInstance(baseInstance);
    const state = { outputs: { n1: { body: { id: "x1" } } }, cursor: { waiting_node_id: "gate" } };
    store.saveState({ organizationId: ORG_A, instanceId: "inst-1", state });

    state.outputs.n1.body.id = "MUTATED"; // мутация после сохранения не должна проникать
    const loaded = store.loadState({ organizationId: ORG_A, instanceId: "inst-1" });
    assert.deepEqual(loaded.outputs.n1.body, { id: "x1" });
    assert.equal(loaded.cursor.waiting_node_id, "gate");
  });

  it("saveState требует существующего экземпляра (FK на workflow_instances)", () => {
    const store = makeStore();
    assert.throws(
      () => store.saveState({ organizationId: ORG_A, instanceId: "нет", state: {} }),
      (error) => error instanceof WorkflowStoreError && error.reason === "instance_not_found",
    );
  });

  it("loadState возвращает null до первого сохранения; clearState удаляет", () => {
    const store = makeStore();
    store.createInstance(baseInstance);
    assert.equal(store.loadState({ organizationId: ORG_A, instanceId: "inst-1" }), null);
    store.saveState({ organizationId: ORG_A, instanceId: "inst-1", state: { x: 1 } });
    assert.deepEqual(store.loadState({ organizationId: ORG_A, instanceId: "inst-1" }), { x: 1 });
    store.clearState({ organizationId: ORG_A, instanceId: "inst-1" });
    assert.equal(store.loadState({ organizationId: ORG_A, instanceId: "inst-1" }), null);
  });
});

describe("Хранилище экземпляров: изоляция арендаторов (§22.6)", () => {
  it("экземпляр и состояние одного арендатора не видны другому", () => {
    const store = makeStore();
    store.createInstance(baseInstance);
    store.saveState({ organizationId: ORG_A, instanceId: "inst-1", state: { x: 1 } });

    assert.throws(
      () => store.getInstance({ organizationId: ORG_B, instanceId: "inst-1" }),
      (error) => error instanceof WorkflowStoreError && error.reason === "instance_not_found",
    );
    assert.equal(store.loadState({ organizationId: ORG_B, instanceId: "inst-1" }), null);
  });
});
