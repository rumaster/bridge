import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FBP_BACKEND_API_METHODS,
  FBP_BRANCH_OPERATORS,
  FBP_NODE_TYPE_DEFINITIONS,
  FBP_NODE_TYPES,
  WORKFLOW_SCHEMA_VERSION,
  arePortTypesCompatible,
  canConnectPorts,
  execInputPortIds,
  execOutputPortIds,
  getNodePortDefinitions,
  validateWorkflowGraphContract,
} from "../../packages/contracts/src/c5.js";
import type { WorkflowNode, WorkflowSchema } from "../../packages/contracts/src/c5.js";
import {
  getNodeDefinition,
  listNodeTypes,
} from "../../services/fbp-engine/src/nodes/registry.js";

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function workflow(nodes: WorkflowNode[], connections: WorkflowSchema["connections"] = []): WorkflowSchema {
  return { schema_version: WORKFLOW_SCHEMA_VERSION, kind: "workflow", nodes, connections };
}

const waitEvent = () => node("evt", "wait-event", { event_type: "message.created" });

/**
 * Consumer-driven контракт C5: движок FBP (провайдер определений узлов и
 * вычислителя Transform) обязан ТОЧНО соответствовать замороженному каталогу
 * узлов из packages/contracts (источник истины). Контракт аддитивен к
 * замороженному wire-контракту C5 (C5_VERSION остаётся 1.0.0).
 */
describe("Контракт C5: каталог нейтральных узлов FBP", () => {
  it("реестр движка ТОЧНО совпадает с каталогом FBP_NODE_TYPES (в обе стороны)", () => {
    assert.deepEqual([...listNodeTypes()].sort(), [...FBP_NODE_TYPES].sort());
  });

  it("каждый тип каталога разрешается в определение с validate() и execute()", () => {
    for (const type of FBP_NODE_TYPES) {
      const definition = getNodeDefinition(type);
      assert.ok(definition, `тип ${type} должен иметь определение`);
      assert.equal(definition.type, type);
      assert.equal(typeof definition.validate, "function", `${type}.validate`);
      assert.equal(typeof definition.execute, "function", `${type}.execute`);
    }
  });

  it("каталог не содержит доменных узлов исходного fbp-engine (нейтральность §13.13-п.1)", () => {
    const nodeTypes = new Set<string>(FBP_NODE_TYPES);
    assert.ok(nodeTypes.has("backend-api"));
    assert.ok(nodeTypes.has("sub_schema"));
    assert.ok(nodeTypes.has("transform"));
    // Никаких прямых доменных/БД-узлов: единственная запись данных — через backend-api.
    for (const forbidden of ["sql", "db", "http", "shell", "email", "crm"]) {
      assert.ok(!nodeTypes.has(forbidden), `узел ${forbidden} недопустим`);
    }
  });

  it("ровно один узел объявлен изменяющим данные — backend-api", () => {
    const mutating = FBP_NODE_TYPE_DEFINITIONS.filter((item) => item.mutatesData).map((item) => item.type);
    assert.deepEqual(mutating, ["backend-api"]);
  });

  it("замораживает версию схемы, методы Backend API и операторы ветвления", () => {
    assert.equal(WORKFLOW_SCHEMA_VERSION, "2.0.0");
    assert.deepEqual([...FBP_BACKEND_API_METHODS], ["GET", "POST", "PUT", "PATCH", "DELETE"]);
    assert.deepEqual(
      FBP_BRANCH_OPERATORS.map((item) => item.value),
      ["truthy", "exists", "equals", "not_equals", "gt", "gte", "lt", "lte"],
    );
  });
});

describe("Контракт C5: порты узлов (единый источник для редактора и движка)", () => {
  it("проверяет совместимость типов портов по общему правилу C5", () => {
    assert.equal(arePortTypesCompatible("exec", "exec"), true);
    assert.equal(arePortTypesCompatible("exec", "object"), false);
    assert.equal(arePortTypesCompatible("object", "any"), true);
    assert.equal(arePortTypesCompatible("string", "number"), false);
  });

  it("wait-event — источник exec: exec-входа нет, есть exec-выход и data: object", () => {
    const evt = waitEvent();
    assert.deepEqual(execInputPortIds(evt), []);
    assert.deepEqual(execOutputPortIds(evt), ["out"]);
    const ports = getNodePortDefinitions(evt);
    assert.deepEqual(
      ports.outputs.map((port) => [port.id, port.type]),
      [["out", "exec"], ["data", "object"]],
    );
  });

  it("transform — pure-функция: exec-портов нет, порты берутся из config", () => {
    const transform = node("t", "transform", {
      code: "return { name: input.raw };",
      inputs: [{ name: "raw", type: "string" }],
      outputs: [{ name: "name", type: "string", path: "result.name" }],
    });
    assert.deepEqual(execInputPortIds(transform), []);
    assert.deepEqual(execOutputPortIds(transform), []);
    const ports = getNodePortDefinitions(transform);
    assert.deepEqual(ports.inputs.map((port) => [port.id, port.type]), [["raw", "string"]]);
    assert.deepEqual(ports.outputs.map((port) => [port.id, port.type]), [["name", "string"]]);
  });

  it("variable_read — pure, variable_write — побочный эффект с exec-портами", () => {
    assert.deepEqual(execInputPortIds(node("r", "variable_read")), []);
    assert.deepEqual(execOutputPortIds(node("r", "variable_read")), []);
    assert.deepEqual(execInputPortIds(node("w", "variable_write")), ["in"]);
    assert.deepEqual(execOutputPortIds(node("w", "variable_write")), ["out"]);
  });

  it("branch — exec-вход, data-входы value/right и два exec-выхода true/false", () => {
    const branch = node("b", "branch", { operator: "truthy" });
    assert.deepEqual(execOutputPortIds(branch), ["true", "false"]);
    const ports = getNodePortDefinitions(branch);
    assert.deepEqual(ports.inputs.map((port) => port.id), ["in", "value", "right"]);
    assert.deepEqual(ports.outputs.map((port) => port.id), ["true", "false"]);
  });

  it("knowledge-base-search — входы keys/tags: string_array, выход documents: object_array", () => {
    const ports = getNodePortDefinitions(node("kb", "knowledge-base-search"));
    assert.deepEqual(
      ports.inputs.map((port) => [port.id, port.type]),
      [["in", "exec"], ["keys", "string_array"], ["tags", "string_array"]],
    );
    assert.deepEqual(
      ports.outputs.map((port) => [port.id, port.type]),
      [["out", "exec"], ["documents", "object_array"]],
    );
  });

  it("merge — динамические exec-входы: всегда ровно один свободный", () => {
    const merge = node("m", "merge");
    assert.deepEqual(execInputPortIds(merge, workflow([merge])), ["in_1", "in_2"]);

    const graph = workflow(
      [waitEvent(), merge],
      [{ id: "c1", from: "evt", fromPort: "out", to: "m", toPort: "in_2" }],
    );
    assert.deepEqual(execInputPortIds(merge, graph), ["in_1", "in_2", "in_3"]);
  });
});

describe("Контракт C5: валидация графа", () => {
  it("принимает минимальную схему с источником события", () => {
    const graph = workflow(
      [waitEvent(), node("w", "variable_write", { inputs: [{ name: "value", type: "object" }] })],
      [{ id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" }],
    );
    assert.doesNotThrow(() => validateWorkflowGraphContract(graph));
  });

  it("отвергает схему без узла «Ожидание события» — её нечем запустить", () => {
    const graph = workflow([node("t", "transform", { code: "return 1;" })]);
    assert.throws(() => validateWorkflowGraphContract(graph), /Ожидание события/);
  });

  it("branch с обеими ветками true/false сохраняется (регрессия: дефект D1)", () => {
    const graph = workflow(
      [
        waitEvent(),
        node("b", "branch", { operator: "exists" }),
        node("w1", "variable_write"),
        node("w2", "variable_write"),
      ],
      [
        { id: "c1", from: "evt", fromPort: "out", to: "b", toPort: "in" },
        { id: "c2", from: "b", fromPort: "true", to: "w1", toPort: "in" },
        { id: "c3", from: "b", fromPort: "false", to: "w2", toPort: "in" },
      ],
    );
    assert.doesNotThrow(() => validateWorkflowGraphContract(graph));
  });

  it("отвергает связь exec→data и несовместимые типы", () => {
    const mixed = workflow(
      [waitEvent(), node("kb", "knowledge-base-search")],
      [{ id: "c1", from: "evt", fromPort: "out", to: "kb", toPort: "keys" }],
    );
    assert.throws(() => validateWorkflowGraphContract(mixed), /смешивает exec-порт и data-порт/);

    const incompatible = workflow(
      [waitEvent(), node("kb", "knowledge-base-search")],
      [{ id: "c1", from: "evt", fromPort: "data", to: "kb", toPort: "keys" }],
    );
    assert.throws(() => validateWorkflowGraphContract(incompatible), /Несовместимые порты/);
  });

  it("на data-вход можно завести только одно ребро, на exec-вход — несколько", () => {
    const twoIntoData = workflow(
      [
        waitEvent(),
        node("t1", "transform", { code: "return [];", outputs: [{ name: "keys", type: "string_array" }] }),
        node("t2", "transform", { code: "return [];", outputs: [{ name: "keys", type: "string_array" }] }),
        node("kb", "knowledge-base-search"),
      ],
      [
        { id: "c1", from: "evt", fromPort: "out", to: "kb", toPort: "in" },
        { id: "c2", from: "t1", fromPort: "keys", to: "kb", toPort: "keys" },
        { id: "c3", from: "t2", fromPort: "keys", to: "kb", toPort: "keys" },
      ],
    );
    assert.throws(() => validateWorkflowGraphContract(twoIntoData), /уже подключён/);
  });

  it("отвергает цикл в exec-графе", () => {
    const graph = workflow(
      [waitEvent(), node("a", "variable_write"), node("b", "variable_write")],
      [
        { id: "c1", from: "evt", fromPort: "out", to: "a", toPort: "in" },
        { id: "c2", from: "a", fromPort: "out", to: "b", toPort: "in" },
        { id: "c3", from: "b", fromPort: "out", to: "a", toPort: "in" },
      ],
    );
    assert.throws(() => validateWorkflowGraphContract(graph), /цикл/);
  });

  it("узел backend-api не может подменить арендатора или актора через config (§13.13-п.4)", () => {
    for (const key of ["organization_id", "actor_user_id", "context"]) {
      const graph = workflow(
        [waitEvent(), node("api", "backend-api", { operation_id: "x", [key]: "spoofed" })],
        [{ id: "c1", from: "evt", fromPort: "out", to: "api", toPort: "in" }],
      );
      assert.throws(() => validateWorkflowGraphContract(graph), /запрещённый ключ/, key);
    }
  });

  it("субсхема требует ровно один start и один end и не допускает событий", () => {
    const base = (nodes: WorkflowNode[]): WorkflowSchema => ({
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "subschema",
      nodes,
      connections: [],
    });
    const start = node("s", "start", { outputs: [{ id: "query", label: "Запрос", type: "string" }] });
    const end = node("e", "end", { inputs: [{ id: "result", label: "Ответ", type: "string" }] });

    assert.doesNotThrow(() => validateWorkflowGraphContract(base([start, end])));
    assert.throws(() => validateWorkflowGraphContract(base([end])), /ровно один start/);
    assert.throws(() => validateWorkflowGraphContract(base([start])), /ровно один end/);
    assert.throws(
      () => validateWorkflowGraphContract(base([start, end, waitEvent()])),
      /недоступен в графе вида/,
    );
  });

  it("узлы start/end недоступны в схеме верхнего уровня", () => {
    const graph = workflow([waitEvent(), node("s", "start")]);
    assert.throws(() => validateWorkflowGraphContract(graph), /недоступен в графе вида/);
  });
});

describe("Контракт C5: проверка связи для редактора", () => {
  const graph = workflow([
    waitEvent(),
    node("kb", "knowledge-base-search"),
    node("t", "transform", { code: "return [];", outputs: [{ name: "keys", type: "string_array" }] }),
  ]);

  it("разрешает корректную связь", () => {
    const result = canConnectPorts(graph, {
      source: "t",
      sourceHandle: "keys",
      target: "kb",
      targetHandle: "keys",
    });
    assert.equal(result.valid, true);
  });

  it("запрещает соединение узла с самим собой и несовместимые типы", () => {
    assert.equal(
      canConnectPorts(graph, { source: "kb", sourceHandle: "out", target: "kb", targetHandle: "in" }).valid,
      false,
    );
    assert.equal(
      canConnectPorts(graph, { source: "evt", sourceHandle: "data", target: "kb", targetHandle: "keys" }).valid,
      false,
    );
  });

  it("запрещает второе ребро в занятый data-вход", () => {
    const occupied: WorkflowSchema = {
      ...graph,
      nodes: [...graph.nodes, node("t2", "transform", { code: "return [];", outputs: [{ name: "keys", type: "string_array" }] })],
      connections: [{ id: "c1", from: "t", fromPort: "keys", to: "kb", toPort: "keys" }],
    };
    const result = canConnectPorts(occupied, {
      source: "t2",
      sourceHandle: "keys",
      target: "kb",
      targetHandle: "keys",
    });
    assert.equal(result.valid, false);
    assert.match(String(result.reason), /уже подключён/);
  });
});

/**
 * Ревизия 2026-07-15: набор про whitelist операций Transform Node удалён вместе с
 * режимом expression (решение A8). У transform остался только JS-текст, изоляция
 * которого проверяется в services/fbp-engine/test/unit/transform-code-sandbox.test.ts.
 */
