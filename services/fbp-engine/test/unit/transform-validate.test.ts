import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateTransformExpression } from "../../src/transform/validate-expression.js";

const fieldMessages = (result) => result.errors.map((error) => `${error.path}: ${error.message}`).join("\n");

describe("Transform Node — валидация выражения на этапе сохранения схемы (§13.4)", () => {
  it("принимает корректное выражение над whitelist", () => {
    const result = validateTransformExpression({
      op: "if",
      cond: { op: "gt", args: [{ op: "get", object: { op: "input" }, path: ["amount"] }, { op: "lit", value: 0 }] },
      then: { op: "lit", value: "positive" },
      else: { op: "lit", value: "non-positive" },
    });
    assert.equal(result.valid, true, fieldMessages(result));
  });

  it("отклоняет операцию вне whitelist ДО сохранения", () => {
    for (const op of ["eval", "require", "fetch", "readFile", "process", "now", "random"]) {
      const result = validateTransformExpression({ op, args: [{ op: "input" }] });
      assert.equal(result.valid, false, `Операция ${op} должна быть отклонена`);
      assert.match(fieldMessages(result), /Недопустимая операция|op/);
    }
  });

  it("отклоняет неверную арность операции", () => {
    const result = validateTransformExpression({ op: "sub", args: [{ op: "lit", value: 1 }] });
    assert.equal(result.valid, false);
    assert.match(fieldMessages(result), /args/);
  });

  it("отклоняет ссылку на несвязанную переменную", () => {
    const result = validateTransformExpression({ op: "var", name: "leak" });
    assert.equal(result.valid, false);
    assert.match(fieldMessages(result), /не связана/);
  });

  it("принимает переменную, связанную map/filter/reduce", () => {
    const result = validateTransformExpression({
      op: "map",
      array: { op: "get", object: { op: "input" }, path: ["items"] },
      as: "item",
      body: { op: "var", name: "item" },
    });
    assert.equal(result.valid, true, fieldMessages(result));
  });

  it("отклоняет опасный сегмент пути get", () => {
    const result = validateTransformExpression({
      op: "get",
      object: { op: "input" },
      path: ["__proto__", "polluted"],
    });
    assert.equal(result.valid, false);
    assert.match(fieldMessages(result), /запрещён/);
  });

  it("отклоняет lit с не-JSON значением", () => {
    const result = validateTransformExpression({ op: "lit", value: undefined });
    assert.equal(result.valid, false);
  });

  it("ограничивает глубину AST", () => {
    let expression: any = { op: "input" };
    for (let depth = 0; depth < 20; depth += 1) {
      expression = { op: "not", args: [expression] };
    }
    const result = validateTransformExpression(expression, { limits: { maxAstDepth: 5 } });
    assert.equal(result.valid, false);
    assert.match(fieldMessages(result), /глубин/);
  });

  it("ограничивает число узлов AST", () => {
    const result = validateTransformExpression(
      { op: "add", args: Array.from({ length: 50 }, () => ({ op: "lit", value: 1 })) },
      { limits: { maxAstNodes: 10 } },
    );
    assert.equal(result.valid, false);
    assert.match(fieldMessages(result), /узлов AST/);
  });
});
