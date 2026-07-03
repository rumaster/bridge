import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExecutionContext } from "../../src/core/execution-context.mjs";
import { WorkflowExecutionError } from "../../src/core/errors.mjs";

const ORG = "org-a";

function makeContext(overrides = {}) {
  return new ExecutionContext({
    organizationId: ORG,
    actorUserId: "user-1",
    trigger: "manual",
    roles: ["manager"],
    instanceId: "instance-1",
    input: { amount: 150, customer: { name: "Иван" } },
    now: () => "2026-07-03T00:00:00.000Z",
    ...overrides,
  });
}

describe("ExecutionContext: мультиарендность по построению", () => {
  it("требует непустой organization_id", () => {
    assert.throws(
      () => makeContext({ organizationId: "" }),
      (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_context",
    );
    assert.throws(
      () => makeContext({ organizationId: undefined }),
      (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_context",
    );
  });

  it("toCallContext() берёт арендатора/актора ТОЛЬКО из контекста экземпляра", () => {
    const ctx = makeContext();
    assert.deepEqual(ctx.toCallContext(), {
      organization_id: ORG,
      actor_user_id: "user-1",
      trigger: "manual",
      roles: ["manager"],
    });
  });

  it("toCallContext() добавляет correlation_id/locale только при наличии", () => {
    const ctx = makeContext({ correlationId: "corr-1", locale: "ru-RU" });
    assert.equal(ctx.toCallContext().correlation_id, "corr-1");
    assert.equal(ctx.toCallContext().locale, "ru-RU");
  });
});

describe("ExecutionContext: сборка входа узла из проводки", () => {
  it("источник params читает параметры Workflow по пути", () => {
    const ctx = makeContext();
    const input = ctx.assembleInput({
      sum: { kind: "params", path: ["amount"] },
      name: { kind: "params", path: ["customer", "name"] },
    });
    assert.deepEqual(input, { sum: 150, name: "Иван" });
  });

  it("источник const клонируется (изоляция от схемы)", () => {
    const ctx = makeContext();
    const source = { kind: "const", value: { nested: [1, 2] } };
    const input = ctx.assembleInput({ c: source });
    input.c.nested.push(3);
    assert.deepEqual(source.value.nested, [1, 2]);
  });

  it("источник node читает результат ранее исполненного узла", () => {
    const ctx = makeContext();
    ctx.setNodeOutput("prev", { status_code: 201, body: { id: "x1" } });
    const input = ctx.assembleInput({ id: { kind: "node", node: "prev", path: ["body", "id"] } });
    assert.deepEqual(input, { id: "x1" });
  });

  it("ссылка на неисполненный узел бросает unknown_node_reference", () => {
    const ctx = makeContext();
    assert.throws(
      () => ctx.assembleInput({ x: { kind: "node", node: "not-yet", path: [] } }),
      (error) => error instanceof WorkflowExecutionError && error.reason === "unknown_node_reference",
    );
  });

  it("неизвестный тип источника бросает invalid_input_source", () => {
    const ctx = makeContext();
    assert.throws(
      () => ctx.assembleInput({ x: { kind: "env", path: [] } }),
      (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_input_source",
    );
  });

  it("опасные ключи входа игнорируются (защита от загрязнения прототипа)", () => {
    const ctx = makeContext();
    const input = ctx.assembleInput({ __proto__: { kind: "const", value: { polluted: true } } });
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(input.polluted, undefined);
  });
});

describe("ExecutionContext: журнал исполнения", () => {
  it("appendJournal формирует запись формы workflow_execution_logs", () => {
    const ctx = makeContext();
    const entry = ctx.appendJournal("node.started", { nodeId: "n1", data: { type: "transform" } });
    assert.equal(entry.organization_id, ORG);
    assert.equal(entry.instance_id, "instance-1");
    assert.equal(entry.node_id, "n1");
    assert.equal(entry.event, "node.started");
    assert.deepEqual(entry.data, { type: "transform" });
    assert.equal(entry.created_at, "2026-07-03T00:00:00.000Z");
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    assert.equal(ctx.journal.length, 1);
  });

  it("id записей журнала детерминированы и различны по порядковому номеру", () => {
    const first = makeContext().appendJournal("a");
    const second = makeContext().appendJournal("a");
    assert.equal(first.id, second.id, "одинаковый (instance, seq) → одинаковый id");
    const ctx = makeContext();
    const e1 = ctx.appendJournal("a");
    const e2 = ctx.appendJournal("b");
    assert.notEqual(e1.id, e2.id);
  });
});
