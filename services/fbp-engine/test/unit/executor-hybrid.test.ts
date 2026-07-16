import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { ExecutionContext } from "../../src/core/execution-context.js";
import { runGraph } from "../../src/core/executor.js";

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function workflow(nodes: any[], connections: any[] = [], kind = "workflow") {
  return { schema_version: WORKFLOW_SCHEMA_VERSION, kind, nodes, connections };
}

function link(id: string, from: string, fromPort: string, to: string, toPort: string) {
  return { id, from, fromPort, to, toPort };
}

function makeCtx(input: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  let tick = 0;
  return new ExecutionContext({
    organizationId: "org-1",
    instanceId: "inst-1",
    workflowId: "wf-1",
    workflowVersionId: "ver-1",
    input,
    now: () => "2026-07-15T00:00:00.000Z",
    monotonic: () => (tick += 1),
    ...overrides,
  });
}

const evt = () => node("evt", "wait-event", { event_type: "message.created" });

const backendClient = {
  calls: [] as any[],
  async call(request: any) {
    this.calls.push(request);
    return { status_code: 200, body: { documents: [{ id: "doc-1" }] } };
  },
};

/**
 * Ревизия 2026-07-15: модель исполнения — гибрид push/pull. Эти тесты проверяют
 * ровно то, чего не было в прежнем движке: ленивое вычисление pure-узлов,
 * ветвление по exec-порту, барьер merge и изоляцию субсхем.
 */
describe("executor 2.0: старт с узла «Ожидание события»", () => {
  it("wait-event отдаёт полезную нагрузку события портом data", async () => {
    const schema = workflow(
      [evt(), node("w", "variable_write", { inputs: [{ name: "payload", type: "object" }] })],
      [link("c1", "evt", "out", "w", "in"), link("c2", "evt", "data", "w", "payload")],
    );
    const ctx = makeCtx({ text: "привет" });
    const result = await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });

    assert.equal(result.status, "completed");
    assert.deepEqual(ctx.getVariable("payload"), { text: "привет" });
  });

  it("отказывается стартовать не с узла события", async () => {
    const schema = workflow([evt(), node("m", "merge")]);
    await assert.rejects(
      () => runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "m" }),
      /только с узла «Ожидание события»/,
    );
  });
});

describe("executor 2.0: pull — pure-узлы вычисляются по требованию", () => {
  it("transform исполняется лениво и мемоизируется для двух потребителей", async () => {
    const schema = workflow(
      [
        evt(),
        node("t", "transform", {
          code: "return { upper: String(input.src.text).toUpperCase() };",
          inputs: [{ name: "src", type: "object" }],
          outputs: [{ name: "upper", type: "string", path: "result.upper" }],
        }),
        node("w1", "variable_write", { inputs: [{ name: "a", type: "string" }] }),
        node("w2", "variable_write", { inputs: [{ name: "b", type: "string" }] }),
      ],
      [
        link("c1", "evt", "out", "w1", "in"),
        link("c2", "w1", "out", "w2", "in"),
        link("c3", "evt", "data", "t", "src"),
        link("c4", "t", "upper", "w1", "a"),
        link("c5", "t", "upper", "w2", "b"),
      ],
    );
    const ctx = makeCtx({ text: "ok" });
    const result = await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });

    assert.equal(ctx.getVariable("a"), "OK");
    assert.equal(ctx.getVariable("b"), "OK");
    // Мемоизация: два потребителя — но узел в трассе ровно один раз.
    const transformRuns = result.trace.filter((entry: any) => entry.nodeId === "t");
    assert.equal(transformRuns.length, 1);
    assert.equal(transformRuns[0].via, "data");
  });

  it("pure-узел, ничей выход которого не нужен, не исполняется вовсе", async () => {
    const schema = workflow(
      [evt(), node("dead", "transform", { code: "throw new Error('не должен исполниться');" })],
      [link("c1", "evt", "out", "evt", "in")].slice(0, 0),
    );
    const result = await runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "evt" });
    assert.equal(result.status, "completed");
    assert.equal(result.trace.some((entry: any) => entry.nodeId === "dead"), false);
  });
});

describe("executor 2.0: ветвление", () => {
  async function runBranch(operator: string, value: unknown, right: unknown) {
    const schema = workflow(
      [
        evt(),
        node("t", "transform", {
          code: "return input.src.value;",
          inputs: [{ name: "src", type: "object" }],
          outputs: [{ name: "value", type: "any" }],
        }),
        node("b", "branch", { operator, right }),
        node("yes", "variable_write", { inputs: [{ name: "hit", type: "string" }] }),
        node("no", "variable_write", { inputs: [{ name: "hit", type: "string" }] }),
        node("cy", "transform", { code: "return 'true';", outputs: [{ name: "v", type: "string" }] }),
        node("cn", "transform", { code: "return 'false';", outputs: [{ name: "v", type: "string" }] }),
      ],
      [
        link("c1", "evt", "out", "b", "in"),
        link("c2", "evt", "data", "t", "src"),
        link("c3", "t", "value", "b", "value"),
        link("c4", "b", "true", "yes", "in"),
        link("c5", "b", "false", "no", "in"),
        link("c6", "cy", "v", "yes", "hit"),
        link("c7", "cn", "v", "no", "hit"),
      ],
    );
    const ctx = makeCtx({ value });
    await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });
    return ctx.getVariable("hit");
  }

  it("поддерживает все восемь операторов", async () => {
    assert.equal(await runBranch("truthy", 1, null), "true");
    assert.equal(await runBranch("truthy", 0, null), "false");
    assert.equal(await runBranch("exists", null, null), "false");
    assert.equal(await runBranch("exists", 0, null), "true");
    assert.equal(await runBranch("equals", 5, 5), "true");
    assert.equal(await runBranch("not_equals", 5, 5), "false");
    assert.equal(await runBranch("gt", 6, 5), "true");
    assert.equal(await runBranch("gte", 5, 5), "true");
    assert.equal(await runBranch("lt", 4, 5), "true");
    assert.equal(await runBranch("lte", 6, 5), "false");
  });

  it("исполняет только выбранную ветку", async () => {
    const schema = workflow(
      [
        evt(),
        node("b", "branch", { operator: "truthy", right: null }),
        node("yes", "variable_write", { inputs: [{ name: "v", type: "string" }] }),
        node("no", "variable_write", { inputs: [{ name: "v", type: "string" }] }),
      ],
      [
        link("c1", "evt", "out", "b", "in"),
        link("c2", "evt", "data", "b", "value"),
        link("c3", "b", "true", "yes", "in"),
        link("c4", "b", "false", "no", "in"),
      ],
    );
    const result = await runGraph({ schema, ctx: makeCtx({ any: 1 }), backendClient, startNodeId: "evt" });
    const visited = result.trace.map((entry: any) => entry.nodeId);
    assert.ok(visited.includes("yes"));
    assert.equal(visited.includes("no"), false);
  });
});

describe("executor 2.0: merge — барьер параллельных потоков", () => {
  it("пропускает поток дальше ровно один раз и только после обоих входов", async () => {
    const schema = workflow(
      [
        evt(),
        node("a", "variable_write", { inputs: [{ name: "a", type: "string" }] }),
        node("b", "variable_write", { inputs: [{ name: "b", type: "string" }] }),
        node("m", "merge"),
        node("after", "variable_write", { inputs: [{ name: "after", type: "string" }] }),
        node("ca", "transform", { code: "return 'a';", outputs: [{ name: "v", type: "string" }] }),
        node("cb", "transform", { code: "return 'b';", outputs: [{ name: "v", type: "string" }] }),
        node("cc", "transform", { code: "return 'done';", outputs: [{ name: "v", type: "string" }] }),
      ],
      [
        // Один exec-выход расходится в две ветки — так стартуют параллельные потоки.
        link("c1", "evt", "out", "a", "in"),
        link("c2", "evt", "out", "b", "in"),
        link("c3", "a", "out", "m", "in_1"),
        link("c4", "b", "out", "m", "in_2"),
        link("c5", "m", "out", "after", "in"),
        link("c6", "ca", "v", "a", "a"),
        link("c7", "cb", "v", "b", "b"),
        link("c8", "cc", "v", "after", "after"),
      ],
    );
    const ctx = makeCtx();
    const result = await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });

    assert.equal(ctx.getVariable("a"), "a");
    assert.equal(ctx.getVariable("b"), "b");
    assert.equal(ctx.getVariable("after"), "done");

    const order = result.trace.filter((e: any) => e.via === "flow").map((e: any) => e.nodeId);
    assert.equal(order.filter((id: string) => id === "after").length, 1, "after — ровно один раз");
    assert.ok(order.indexOf("m") > order.indexOf("a"));
    assert.ok(order.indexOf("m") > order.indexOf("b"));
  });
});

describe("executor 2.0: knowledge-base-search", () => {
  it("шлёт keys/tags и отдаёт documents", async () => {
    const schema = workflow(
      [
        evt(),
        node("keys", "transform", { code: "return ['цена', 'доставка'];", outputs: [{ name: "v", type: "string_array" }] }),
        node("kb", "knowledge-base-search", { top_k: 3 }),
        node("w", "variable_write", { inputs: [{ name: "docs", type: "object_array" }] }),
      ],
      [
        link("c1", "evt", "out", "kb", "in"),
        link("c2", "keys", "v", "kb", "keys"),
        link("c3", "kb", "out", "w", "in"),
        link("c4", "kb", "documents", "w", "docs"),
      ],
    );
    const client = { calls: [] as any[], async call(r: any) { this.calls.push(r); return { status_code: 200, body: { documents: [{ id: "d1" }] } }; } };
    const ctx = makeCtx();
    await runGraph({ schema, ctx, backendClient: client, startNodeId: "evt" });

    assert.deepEqual(client.calls[0].body, { keys: ["цена", "доставка"], tags: [], top_k: 3 });
    assert.deepEqual(ctx.getVariable("docs"), [{ id: "d1" }]);
  });
});

describe("executor 2.0: субсхемы", () => {
  const sub = workflow(
    [
      node("s", "start", { outputs: [{ id: "query", label: "Запрос", type: "string" }] }),
      node("t", "transform", {
        code: "return { answer: input.q + '!' };",
        inputs: [{ name: "q", type: "string" }],
        outputs: [{ name: "answer", type: "string", path: "result.answer" }],
      }),
      node("e", "end", { inputs: [{ id: "result", label: "Ответ", type: "string" }] }),
    ],
    [link("c1", "s", "out", "e", "in"), link("c2", "s", "query", "t", "q"), link("c3", "t", "answer", "e", "result")],
    "subschema",
  );

  it("передаёт данные через границу start/end", async () => {
    const schema = workflow(
      [
        evt(),
        node("q", "transform", { code: "return 'вопрос';", outputs: [{ name: "v", type: "string" }] }),
        node("sub", "sub_schema", {
          subSchemaSlug: "answer",
          ports: { inputs: [{ id: "query", type: "string" }], outputs: [{ id: "result", type: "string" }] },
        }),
        node("w", "variable_write", { inputs: [{ name: "out", type: "string" }] }),
      ],
      [
        link("c1", "evt", "out", "sub", "in"),
        link("c2", "q", "v", "sub", "query"),
        link("c3", "sub", "out", "w", "in"),
        link("c4", "sub", "result", "w", "out"),
      ],
    );
    const ctx = makeCtx({}, { resolveSubSchema: () => sub });
    await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });
    assert.equal(ctx.getVariable("out"), "вопрос!");
  });

  it("не пропускает переменные родителя внутрь субсхемы", async () => {
    const leaky = workflow(
      [
        node("s", "start", { outputs: [{ id: "query", label: "Запрос", type: "string" }] }),
        node("r", "variable_read", { outputs: [{ name: "secret", type: "string" }] }),
        node("e", "end", { inputs: [{ id: "result", label: "Ответ", type: "any" }] }),
      ],
      [link("c1", "s", "out", "e", "in"), link("c2", "r", "secret", "e", "result")],
      "subschema",
    );
    const schema = workflow(
      [
        evt(),
        node("wsecret", "variable_write", { inputs: [{ name: "secret", type: "string" }] }),
        node("cs", "transform", { code: "return 'тайна';", outputs: [{ name: "v", type: "string" }] }),
        node("sub", "sub_schema", { subSchemaSlug: "leaky", ports: { inputs: [], outputs: [{ id: "result", type: "any" }] } }),
        node("w", "variable_write", { inputs: [{ name: "leaked", type: "any" }] }),
      ],
      [
        link("c1", "evt", "out", "wsecret", "in"),
        link("c2", "cs", "v", "wsecret", "secret"),
        link("c3", "wsecret", "out", "sub", "in"),
        link("c4", "sub", "out", "w", "in"),
        link("c5", "sub", "result", "w", "leaked"),
      ],
    );
    const ctx = makeCtx({}, { resolveSubSchema: () => leaky });
    await runGraph({ schema, ctx, backendClient, startNodeId: "evt" });

    assert.equal(ctx.getVariable("secret"), "тайна");
    assert.equal(ctx.getVariable("leaked"), null, "переменная родителя не должна быть видна субсхеме");
  });

  it("ловит рекурсивную ссылку на субсхему", async () => {
    const recursive = workflow(
      [
        node("s", "start", { outputs: [] }),
        node("inner", "sub_schema", { subSchemaSlug: "recursive", ports: { inputs: [], outputs: [] } }),
        node("e", "end", { inputs: [] }),
      ],
      [link("c1", "s", "out", "inner", "in"), link("c2", "inner", "out", "e", "in")],
      "subschema",
    );
    const schema = workflow(
      [evt(), node("sub", "sub_schema", { subSchemaSlug: "recursive", ports: { inputs: [], outputs: [] } })],
      [link("c1", "evt", "out", "sub", "in")],
    );
    const ctx = makeCtx({}, { resolveSubSchema: () => recursive });
    await assert.rejects(
      () => runGraph({ schema, ctx, backendClient, startNodeId: "evt" }),
      /рекурсивная ссылка на субсхему/,
    );
  });
});

describe("executor 2.0: трасса", () => {
  it("пишет по узлу via/длительность/входы/выходы и помечает падение", async () => {
    const schema = workflow(
      [evt(), node("boom", "transform", { code: "throw new Error('бум');", outputs: [{ name: "v", type: "any" }] }),
        node("w", "variable_write", { inputs: [{ name: "v", type: "any" }] })],
      [link("c1", "evt", "out", "w", "in"), link("c2", "boom", "v", "w", "v")],
    );
    await assert.rejects(() => runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "evt" }));
  });

  it("различает flow и data в трассе", async () => {
    const schema = workflow(
      [
        evt(),
        node("t", "transform", { code: "return 'x';", outputs: [{ name: "v", type: "string" }] }),
        node("w", "variable_write", { inputs: [{ name: "v", type: "string" }] }),
      ],
      [link("c1", "evt", "out", "w", "in"), link("c2", "t", "v", "w", "v")],
    );
    const result = await runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "evt" });
    const byId = Object.fromEntries(result.trace.map((e: any) => [e.nodeId, e]));
    assert.equal(byId.evt.via, "flow");
    assert.equal(byId.w.via, "flow");
    assert.equal(byId.t.via, "data");
    assert.deepEqual(byId.w.inputs, { v: "x" });
    assert.equal(typeof byId.t.durationMs, "number");
  });

  it("трасса переживает падение: видно, до какого узла дошли и где упали", async () => {
    // Трасса — локальный массив runGraph, и при выбросе она пропадала вместе с
    // кадром стека: вызывающий получал ошибку без единого шага. Именно на падении
    // она и нужна — тест-прогон схемы обязан показать место обрыва.
    const schema = workflow(
      [
        evt(),
        node("ok", "variable_write", { inputs: [{ name: "payload", type: "object" }] }),
        node("boom", "transform", { code: "throw new Error('взорвалось');" }),
        node("after", "variable_write", { inputs: [{ name: "v", type: "string" }] }),
      ],
      [
        link("c1", "evt", "out", "ok", "in"),
        link("c2", "evt", "data", "ok", "payload"),
        link("c3", "ok", "out", "after", "in"),
        link("c4", "boom", "v", "after", "v"),
      ],
    );

    const error = await runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "evt" }).then(
      () => null,
      (caught: any) => caught,
    );

    assert.ok(error, "прогон обязан упасть");
    assert.ok(Array.isArray(error.trace), "трасса прикреплена к ошибке");

    const visited = error.trace.map((entry: any) => entry.nodeId);
    // Дошли: evt и ok отработали до обрыва.
    assert.deepEqual(visited.slice(0, 2), ["evt", "ok"]);

    const failed = error.trace.find((entry: any) => entry.failed);
    assert.equal(failed.nodeId, "boom");
    assert.equal(failed.outputs, null);
    assert.match(failed.message, /взорвалось/);
    // Узел за местом обрыва не исполнялся и в трассе его нет.
    assert.equal(visited.includes("after"), false);
  });

  it("трасса не сериализуется вместе с ошибкой в журнал", async () => {
    // Ошибка уходит в журнал и в ответ C5; трасса возвращается отдельным полем и не
    // должна попасть туда вторым, несогласованным экземпляром.
    const schema = workflow(
      [evt(), node("boom", "transform", { code: "throw new Error('bang');" }), node("after", "variable_write", { inputs: [{ name: "v", type: "string" }] })],
      [link("c1", "evt", "out", "after", "in"), link("c2", "boom", "v", "after", "v")],
    );

    const error = await runGraph({ schema, ctx: makeCtx(), backendClient, startNodeId: "evt" }).then(
      () => null,
      (caught: any) => caught,
    );

    assert.ok(Array.isArray(error.trace));
    assert.equal(Object.keys(error).includes("trace"), false, "поле неперечислимо");
    // Собственные поля ошибки (nodeId, reason) остаются — они и должны попадать в
    // журнал. Не должна попадать только трасса.
    assert.equal(JSON.stringify({ ...error }).includes("trace"), false);
  });
});
