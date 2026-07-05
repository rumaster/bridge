import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRANSFORM_ALLOWED_OPERATIONS,
} from "../../../../packages/contracts/src/c5.js";
import { TransformEvaluationError } from "../../src/transform/errors.js";
import { evaluateTransform } from "../../src/transform/evaluator.js";

const get = (path) => ({ op: "get", object: { op: "input" }, path });

describe("Transform Node — безопасный вычислитель выражений (§13.4)", () => {
  it("вычисляет арифметику, строки, массивы и объекты над input", () => {
    const expression = {
      op: "merge",
      args: [
        { op: "lit", value: { kind: "summary" } },
        {
          op: "from_entries",
          args: [
            {
              op: "array_concat",
              args: [
                { op: "lit", value: [["total", 0]] },
                {
                  op: "lit",
                  value: [["greeting", "hi"]],
                },
              ],
            },
          ],
        },
      ],
    };
    const value = evaluateTransform(expression, {});
    assert.deepEqual(value, { kind: "summary", total: 0, greeting: "hi" });
  });

  it("видит ТОЛЬКО свой input и не имеет доступа к внешнему контексту", () => {
    const value = evaluateTransform(
      { op: "get", object: { op: "input" }, path: ["order", "total"] },
      { order: { total: 42 }, secret_should_not_leak: "nope" },
    );
    assert.equal(value, 42);
  });

  it("map/filter/reduce работают с лексически ограниченными переменными", () => {
    const doubledEvens = {
      op: "map",
      array: {
        op: "filter",
        array: get(["numbers"]),
        as: "n",
        body: { op: "eq", args: [{ op: "mod", args: [{ op: "var", name: "n" }, { op: "lit", value: 2 }] }, { op: "lit", value: 0 }] },
      },
      as: "n",
      body: { op: "mul", args: [{ op: "var", name: "n" }, { op: "lit", value: 2 }] },
    };
    assert.deepEqual(evaluateTransform(doubledEvens, { numbers: [1, 2, 3, 4] }), [4, 8]);

    const sum = {
      op: "reduce",
      array: get(["numbers"]),
      as: "n",
      acc: "total",
      init: { op: "lit", value: 0 },
      body: { op: "add", args: [{ op: "var", name: "total" }, { op: "var", name: "n" }] },
    };
    assert.equal(evaluateTransform(sum, { numbers: [1, 2, 3, 4] }), 10);
  });

  it("детерминирован: одинаковый вход даёт одинаковый результат", () => {
    const expression = { op: "concat", args: [get(["a"]), { op: "lit", value: "-" }, get(["b"]) ] };
    const first = evaluateTransform(expression, { a: "x", b: "y" });
    const second = evaluateTransform(expression, { a: "x", b: "y" });
    assert.equal(first, second);
    assert.equal(first, "x-y");
  });

  it("в whitelist НЕТ операций доступа к среде/сети/ФС/секретам/времени/ГСЧ/коду", () => {
    for (const forbidden of [
      "eval",
      "require",
      "import",
      "fetch",
      "readFile",
      "writeFile",
      "process",
      "env",
      "now",
      "date_now",
      "random",
      "uuid",
      "exec",
      "spawn",
      "Function",
    ]) {
      assert.equal(
        TRANSFORM_ALLOWED_OPERATIONS.includes(forbidden),
        false,
        `Операция "${forbidden}" не должна быть в whitelist`,
      );
    }
  });

  it("не может обратиться к прототипу через get-путь (возвращает null)", () => {
    const value = evaluateTransform(get(["__proto__", "polluted"]), { a: 1 });
    assert.equal(value, null);
  });

  it("не загрязняет Object.prototype: опасные ключи отвергаются", () => {
    assert.throws(
      () =>
        evaluateTransform(
          { op: "from_entries", args: [{ op: "lit", value: [["__proto__", { polluted: true }]] }] },
          {},
        ),
      (error) => error instanceof TransformEvaluationError && error.reason === "type_error",
    );
    const merged = evaluateTransform(
      { op: "merge", args: [{ op: "lit", value: {} }, { op: "lit", value: { safe: 1 } }] },
      {},
    );
    assert.deepEqual(merged, { safe: 1 });
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it("обрывает вычисление по бюджету шагов (нет неограниченных циклов)", () => {
    const huge = Array.from({ length: 5000 }, (_, index) => index);
    const nested = {
      op: "map",
      array: get(["items"]),
      as: "outer",
      body: {
        op: "map",
        array: get(["items"]),
        as: "inner",
        body: { op: "add", args: [{ op: "var", name: "outer" }, { op: "var", name: "inner" }] },
      },
    };
    assert.throws(
      () => evaluateTransform(nested, { items: huge }, { maxSteps: 10000 }),
      (error) => error instanceof TransformEvaluationError && error.reason === "step_budget_exceeded",
    );
  });

  it("ограничивает размер результата", () => {
    const expression = {
      op: "map",
      array: get(["items"]),
      as: "n",
      body: { op: "lit", value: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
    };
    assert.throws(
      () =>
        evaluateTransform(expression, { items: Array.from({ length: 1000 }, (_, i) => i) }, {
          maxResultBytes: 512,
        }),
      (error) => error instanceof TransformEvaluationError && error.reason === "result_too_large",
    );
  });

  it("ограничивает длину строкового результата", () => {
    const expression = { op: "concat", args: [get(["a"]), get(["a"])] };
    assert.throws(
      () => evaluateTransform(expression, { a: "abcdef" }, { maxStringLength: 8 }),
      (error) => error instanceof TransformEvaluationError && error.reason === "string_too_long",
    );
  });

  it("операции с датами детерминированы и не читают системное время", () => {
    const ms = evaluateTransform({ op: "date_parse_iso", args: [{ op: "lit", value: "2026-01-01T00:00:00.000Z" }] }, {});
    const plusDay = evaluateTransform(
      { op: "date_to_iso", args: [{ op: "date_add_days", args: [{ op: "lit", value: ms }, { op: "lit", value: 1 }] }] },
      {},
    );
    assert.equal(plusDay, "2026-01-02T00:00:00.000Z");
  });
});
