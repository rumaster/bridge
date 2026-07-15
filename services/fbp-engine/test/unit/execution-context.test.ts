import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExecutionContext } from "../../src/core/execution-context.js";
import { WorkflowExecutionError } from "../../src/core/errors.js";

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

/**
 * Ревизия 2026-07-15: `assembleInput`/`resolveSource` удалены вместе с
 * декларативной проводкой — вход узла собирает исполнитель по data-связям. От
 * контекста осталось хранилище переменных для пары variable_read/variable_write.
 */
describe("ExecutionContext: переменные экземпляра", () => {
  it("setVariable/getVariable хранят значение, неизвестная переменная — null", () => {
    const ctx = makeContext();
    ctx.setVariable("stage", "новый");
    assert.equal(ctx.getVariable("stage"), "новый");
    assert.equal(ctx.getVariable("никогда-не-писали"), null);
  });

  it("значения клонируются на входе и на выходе (мутация не протекает в контекст)", () => {
    const ctx = makeContext();
    const written = { list: [1, 2] };
    ctx.setVariable("data", written);
    written.list.push(3);
    assert.deepEqual(ctx.getVariable("data"), { list: [1, 2] }, "мутация после записи не должна менять переменную");

    const read = ctx.getVariable("data");
    read.list.push(99);
    assert.deepEqual(ctx.getVariable("data"), { list: [1, 2] }, "мутация прочитанного не должна менять переменную");
  });

  it("опасные и пустые имена переменных отвергаются (защита от загрязнения прототипа)", () => {
    const ctx = makeContext();
    for (const name of ["__proto__", "prototype", "constructor", ""]) {
      assert.throws(
        () => ctx.setVariable(name, { polluted: true }),
        (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_variable_name",
        `имя "${name}" должно быть отклонено`,
      );
    }
    assert.equal((Object.prototype as any).polluted, undefined);
    assert.equal(ctx.getVariable("__proto__"), null);
  });

  it("переменные из конструктора принимаются, опасные ключи отбрасываются молча", () => {
    // Ключ вычисляемый, а не литеральный: литеральный `__proto__:` задаёт прототип
    // объекта и собственным свойством не становится — проверка была бы холостой.
    const ctx = makeContext({ variables: { seeded: 7, ["__proto__"]: { polluted: true } } });
    assert.equal(ctx.getVariable("seeded"), 7);
    assert.equal(ctx.getVariable("__proto__"), null);
    assert.equal((Object.prototype as any).polluted, undefined);
  });
});

describe("ExecutionContext: изоляция субсхемы (createChild)", () => {
  it("дочерний контекст наследует арендатора/актора, но НЕ переменные родителя", () => {
    const ctx = makeContext();
    ctx.setVariable("secret", "тайна");

    const child = ctx.createChild({ input: { query: "вопрос" } });
    assert.equal(child.organizationId, ORG);
    assert.deepEqual(child.toCallContext(), ctx.toCallContext());
    assert.deepEqual(child.params, { query: "вопрос" });
    // Переменные родителя внутрь субсхемы не протекают: иначе субсхема молча
    // зависела бы от вызывающего графа и перестала быть переиспользуемой.
    assert.equal(child.getVariable("secret"), null);
  });

  it("запись переменной в субсхеме не видна родителю", () => {
    const ctx = makeContext();
    const child = ctx.createChild({ input: {} });
    child.setVariable("inner", "значение");
    assert.equal(ctx.getVariable("inner"), null);
  });
});

describe("ExecutionContext: разрешение субсхем", () => {
  it("callback получает арендатора из контекста, результат клонируется", async () => {
    const seen: any[] = [];
    const schema = { kind: "subschema", nodes: [] };
    const ctx = makeContext({
      resolveSubSchema: (args: any) => {
        seen.push(args);
        return schema;
      },
    });

    const resolved = await ctx.resolveSubSchema(" answer ");
    assert.deepEqual(seen, [{ organizationId: ORG, slug: "answer" }], "slug тримится, арендатор — из контекста");
    assert.deepEqual(resolved, schema);
    assert.notEqual(resolved, schema, "схема отдаётся копией, а не общим объектом");
  });

  it("без callback берёт схему из реестра, иначе бросает subschema_not_found", async () => {
    const ctx = makeContext({ resolvedSubSchemas: { known: { kind: "subschema", nodes: [] } } });
    assert.deepEqual(await ctx.resolveSubSchema("known"), { kind: "subschema", nodes: [] });
    await assert.rejects(
      () => ctx.resolveSubSchema("unknown"),
      (error) => error instanceof WorkflowExecutionError && error.reason === "subschema_not_found",
    );
    await assert.rejects(
      () => ctx.resolveSubSchema("  "),
      (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_subschema_ref",
    );
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

describe("ExecutionContext: монотонные часы трассы", () => {
  it("elapsedMs() считает от старта контекста по инъецированным часам", () => {
    let tick = 100;
    const ctx = makeContext({ monotonic: () => tick });
    assert.equal(ctx.elapsedMs(), 0, "на старте прошло 0 мс");
    tick = 142;
    assert.equal(ctx.elapsedMs(), 42);
  });
});

describe("ExecutionContext: внешнее состояние (workflow_instance_state, ТЗ §25.3)", () => {
  it("snapshot() содержит всё для восстановления, но НЕ журнал", () => {
    const ctx = makeContext();
    ctx.setNodeOutput("n1", { status_code: 201, body: { id: "x1" } });
    ctx.setVariable("stage", "готово");
    ctx.appendJournal("node.completed", { nodeId: "n1" });

    const snapshot = ctx.snapshot();
    assert.equal(snapshot.organization_id, ORG);
    assert.equal(snapshot.instance_id, "instance-1");
    assert.deepEqual(snapshot.input, { amount: 150, customer: { name: "Иван" } });
    assert.deepEqual(snapshot.outputs.n1, { status_code: 201, body: { id: "x1" } });
    assert.deepEqual(snapshot.variables, { stage: "готово" });
    assert.equal(snapshot.seq, 1, "порядковый счётчик журнала сохранён");
    assert.equal("journal" in snapshot, false, "журнал уходит в workflow_execution_logs, не в состояние");
  });

  it("fromSnapshot() восстанавливает выходы, переменные и продолжает нумерацию журнала", () => {
    const ctx = makeContext();
    ctx.setNodeOutput("n1", { body: { id: "x1" } });
    ctx.setVariable("stage", "готово");
    const firstEntryId = ctx.appendJournal("node.completed", { nodeId: "n1" }).id;
    const snapshot = ctx.snapshot();

    const restored = ExecutionContext.fromSnapshot(snapshot, { now: () => "2026-07-04T00:00:00.000Z" });
    assert.equal(restored.organizationId, ORG);
    assert.equal(restored.instanceId, "instance-1");
    assert.equal(restored.hasNodeOutput("n1"), true);
    assert.deepEqual(restored.getNodeOutput("n1"), { body: { id: "x1" } });
    assert.equal(restored.getVariable("stage"), "готово");
    // Нумерация журнала продолжается с сохранённого seq — id не коллизируют.
    const next = restored.appendJournal("node.started", { nodeId: "n2" });
    assert.notEqual(next.id, firstEntryId, "seq продолжен → id новой записи отличается от seq=1");
  });

  it("snapshot → fromSnapshot изолирует восстановленные результаты (глубокое копирование)", () => {
    const ctx = makeContext();
    const output = { list: [1, 2] };
    ctx.setNodeOutput("n1", output);
    const snapshot = ctx.snapshot();
    output.list.push(3); // мутация после снимка не должна затрагивать состояние

    const restored = ExecutionContext.fromSnapshot(snapshot, { now: () => "2026-07-04T00:00:00.000Z" });
    assert.deepEqual(restored.getNodeOutput("n1"), { list: [1, 2] });
  });

  it("fromSnapshot() игнорирует опасные ключи результатов (защита прототипа)", () => {
    const restored = ExecutionContext.fromSnapshot(
      {
        organization_id: ORG,
        instance_id: "instance-1",
        input: {},
        // Вычисляемый ключ, а не литеральный `__proto__:` — иначе свойство ушло бы
        // в прототип и цикл восстановления его вовсе не увидел бы.
        outputs: { ["__proto__"]: { polluted: true }, safe: { ok: 1 } },
        seq: 0,
      },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    assert.equal((Object.prototype as any).polluted, undefined);
    assert.equal(restored.hasNodeOutput("__proto__"), false, "опасный ключ не восстанавливается");
    assert.equal(restored.hasNodeOutput("safe"), true);
  });

  it("fromSnapshot() отклоняет не-объект", () => {
    assert.throws(
      () => ExecutionContext.fromSnapshot(null),
      (error) => error instanceof WorkflowExecutionError && error.reason === "invalid_instance_state",
    );
  });
});
