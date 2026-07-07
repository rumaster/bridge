import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FBP_NODE_TYPE_DEFINITIONS,
  FBP_BACKEND_API_METHODS,
  FBP_INPUT_SOURCE_KINDS,
  FBP_NODE_TYPES,
  arePortTypesCompatible,
  TRANSFORM_ALLOWED_OPERATIONS,
  TRANSFORM_FUNCTION_OPERATIONS,
  TRANSFORM_STRUCTURAL_OPERATIONS,
  WORKFLOW_SCHEMA_VERSION,
} from "../../packages/contracts/src/c5.js";
import {
  getNodeDefinition,
  listNodeTypes,
} from "../../services/fbp-engine/src/nodes/registry.js";
import { validateTransformExpression } from "../../services/fbp-engine/src/transform/validate-expression.js";

/**
 * Consumer-driven контракт C5: движок FBP (провайдер определений узлов и
 * вычислителя Transform) обязан ТОЧНО соответствовать замороженному каталогу
 * узлов и whitelist операций из packages/contracts (источник истины). Контракт
 * аддитивен к замороженному wire-контракту C5 (C5_VERSION остаётся 1.0.0).
 */
describe("Контракт C5: каталог нейтральных узлов FBP", () => {
  it("реестр движка ТОЧНО совпадает с каталогом FBP_NODE_TYPES (в обе стороны)", () => {
    assert.deepEqual([...listNodeTypes()].sort(), [...FBP_NODE_TYPES].sort());
  });

  it("каталог узлов содержит типизированные порты и остаётся источником FBP_NODE_TYPES", () => {
    assert.deepEqual(
      FBP_NODE_TYPE_DEFINITIONS.map((definition) => definition.type),
      [...FBP_NODE_TYPES],
    );

    for (const definition of FBP_NODE_TYPE_DEFINITIONS) {
      assert.ok(definition.label.length > 0, `${definition.type}.label`);
      assert.ok(Array.isArray(definition.ports) && definition.ports.length > 0, `${definition.type}.ports`);
      for (const port of definition.ports) {
        assert.ok(port.id.length > 0, `${definition.type}.ports[].id`);
        assert.ok(["input", "output"].includes(port.direction), `${definition.type}.${port.id}.direction`);
        assert.ok(port.type.length > 0, `${definition.type}.${port.id}.type`);
      }
    }

    const branch = FBP_NODE_TYPE_DEFINITIONS.find((definition) => definition.type === "branch");
    assert.deepEqual(
      branch?.ports.filter((port) => port.direction === "output").map((port) => port.id).sort(),
      ["false", "true"],
    );
  });

  it("проверяет совместимость типов портов по общему правилу C5", () => {
    assert.equal(arePortTypesCompatible("exec", "exec"), true);
    assert.equal(arePortTypesCompatible("exec", "object"), false);
    assert.equal(arePortTypesCompatible("object", "any"), true);
    assert.equal(arePortTypesCompatible("string", "number"), false);
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
    assert.equal(FBP_NODE_TYPES.length, 6);
    assert.ok(FBP_NODE_TYPES.includes("backend-api"));
    assert.ok(FBP_NODE_TYPES.includes("transform"));
    // Никаких прямых доменных/БД-узлов: единственная запись данных — через backend-api.
    for (const forbidden of ["sql", "db", "http", "shell", "exec", "email", "crm"]) {
      assert.ok(!nodeTypes.has(forbidden), `узел ${forbidden} недопустим`);
    }
  });

  it("замораживает версию схемы, методы Backend API и виды источников входа", () => {
    assert.equal(WORKFLOW_SCHEMA_VERSION, "1.0.0");
    assert.deepEqual([...FBP_BACKEND_API_METHODS], ["GET", "POST", "PUT", "PATCH", "DELETE"]);
    assert.deepEqual([...FBP_INPUT_SOURCE_KINDS], ["params", "node", "const"]);
  });
});

describe("Контракт C5: whitelist операций Transform Node (изоляция по построению)", () => {
  it("whitelist = структурные + функциональные операции", () => {
    assert.deepEqual(
      [...TRANSFORM_ALLOWED_OPERATIONS].sort(),
      [...TRANSFORM_STRUCTURAL_OPERATIONS, ...Object.keys(TRANSFORM_FUNCTION_OPERATIONS)].sort(),
    );
  });

  it("НЕ содержит операций доступа к сети/ФС/окружению/секретам/системному времени/ГСЧ/произвольному коду", () => {
    const forbidden = [
      "now", "today", "random", "rand", "uuid",
      "fetch", "http", "request", "net", "socket",
      "read_file", "readfile", "write_file", "fs", "open",
      "env", "getenv", "secret", "credentials",
      "eval", "exec", "spawn", "require", "import", "process", "function",
    ];
    for (const op of forbidden) {
      assert.ok(!TRANSFORM_ALLOWED_OPERATIONS.includes(op), `операция ${op} не должна быть в whitelist`);
    }
  });

  it("валидатор принимает КАЖДУЮ операцию из whitelist и отвергает операцию вне него", () => {
    // Любая допустимая функциональная операция с корректной арностью проходит валидацию.
    for (const [op, spec] of Object.entries(TRANSFORM_FUNCTION_OPERATIONS)) {
      const args = Array.from({ length: spec.minArgs }, () => ({ op: "lit", value: 1 }));
      const result = validateTransformExpression({ op, args });
      assert.equal(result.valid, true, `${op} должна валидироваться: ${JSON.stringify(result.errors)}`);
    }
    // Операция вне whitelist отвергается на этапе сохранения.
    const rejected = validateTransformExpression({ op: "eval", args: [{ op: "lit", value: "code" }] });
    assert.equal(rejected.valid, false);
    assert.ok(rejected.errors.length > 0);
  });

  it("каждая функциональная операция объявляет корректную арность", () => {
    for (const [op, spec] of Object.entries(TRANSFORM_FUNCTION_OPERATIONS)) {
      assert.equal(typeof spec.minArgs, "number", `${op}.minArgs`);
      assert.equal(typeof spec.maxArgs, "number", `${op}.maxArgs`);
      assert.ok(spec.minArgs >= 0 && spec.maxArgs >= spec.minArgs, `${op}: minArgs<=maxArgs`);
      assert.equal(typeof spec.category, "string", `${op}.category`);
    }
  });
});
