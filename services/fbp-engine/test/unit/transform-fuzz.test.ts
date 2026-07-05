import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRANSFORM_ALLOWED_OPERATIONS,
  TRANSFORM_DEFAULT_LIMITS,
} from "../../../../packages/contracts/src/c5.js";
import { TransformEvaluationError } from "../../src/transform/errors.js";
import { evaluateTransform } from "../../src/transform/evaluator.js";
import { validateTransformExpression } from "../../src/transform/validate-expression.js";

/**
 * Детерминированный ГСЧ mulberry32 — фаззинг воспроизводим по seed, без обращения
 * к `Math.random`/`Date.now` (ТЗ: тесты детерминированы). Seed передаётся явно.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

// Полезные (валидные) листья: только input/литералы/связанные переменные.
function randomLeaf(rng, boundVars) {
  const options = [
    () => ({ op: "lit", value: Math.floor(rng() * 100) }),
    () => ({ op: "lit", value: rng() > 0.5 ? "s" : "" }),
    () => ({ op: "lit", value: rng() > 0.5 }),
    () => ({ op: "lit", value: [1, 2, 3] }),
    () => ({ op: "input" }),
  ];
  if (boundVars.length > 0 && rng() > 0.5) {
    return { op: "var", name: pick(rng, boundVars) };
  }
  return pick(rng, options)();
}

// Случайное ВАЛИДНОЕ выражение ограниченной глубины из whitelist-операций.
function randomValidExpression(rng, depth, boundVars) {
  if (depth <= 0) {
    return randomLeaf(rng, boundVars);
  }
  const kind = rng();
  if (kind < 0.25) {
    return {
      op: "if",
      cond: { op: "lit", value: rng() > 0.5 },
      then: randomValidExpression(rng, depth - 1, boundVars),
      else: randomValidExpression(rng, depth - 1, boundVars),
    };
  }
  if (kind < 0.45) {
    const alias = `v${depth}`;
    return {
      op: "map",
      array: { op: "lit", value: [1, 2, 3] },
      as: alias,
      body: randomValidExpression(rng, depth - 1, [...boundVars, alias]),
    };
  }
  if (kind < 0.6) {
    const alias = `v${depth}`;
    return {
      op: "filter",
      array: { op: "lit", value: [1, 2, 3, 4] },
      as: alias,
      body: { op: "eq", args: [{ op: "mod", args: [{ op: "var", name: alias }, { op: "lit", value: 2 }] }, { op: "lit", value: 0 }] },
    };
  }
  if (kind < 0.75) {
    return {
      op: "concat",
      args: [
        { op: "to_string", args: [randomValidExpression(rng, depth - 1, boundVars)] },
        { op: "lit", value: "-" },
      ],
    };
  }
  if (kind < 0.9) {
    return {
      op: "merge",
      args: [
        { op: "lit", value: { base: 1 } },
        { op: "lit", value: { extra: 2 } },
      ],
    };
  }
  return {
    op: "add",
    args: [
      { op: "to_number", args: [randomValidExpression(rng, depth - 1, boundVars)] },
      { op: "lit", value: 1 },
    ],
  };
}

// Операции/идентификаторы, которых НЕ должно быть в грамматике: любая попытка
// выхода из «песочницы» — доступ к процессу/среде/сети/ФС/секретам/времени/ГСЧ/коду.
const FORBIDDEN_OPS = [
  "eval", "Function", "require", "import", "constructor", "__proto__", "prototype",
  "process", "global", "globalThis", "env", "getenv", "readFile", "writeFile",
  "fs", "readdir", "unlink", "fetch", "http", "https", "request", "net", "socket",
  "exec", "execSync", "spawn", "child_process", "now", "Date", "date_now", "time",
  "timestamp", "random", "rand", "uuid", "secret", "token", "credentials", "atob",
  "btoa", "Buffer", "Reflect", "Proxy", "WebAssembly", "setTimeout", "queueMicrotask",
];

describe("Transform Node — фаззинг грамматики (§13.4): изоляция «по построению»", () => {
  it("любая запрещённая операция отвергается на ВАЛИДАЦИИ (не на исполнении)", () => {
    for (const op of FORBIDDEN_OPS) {
      assert.equal(
        TRANSFORM_ALLOWED_OPERATIONS.includes(op),
        false,
        `Операция "${op}" не должна быть в whitelist`,
      );

      const expression = { op, args: [{ op: "input" }] };
      const result = validateTransformExpression(expression);
      assert.equal(result.valid, false, `Операция "${op}" должна быть отвергнута валидацией`);
      assert.ok(
        result.errors.some((e) => /Недопустимая операция/.test(e.message)),
        `Валидация "${op}" должна сообщать о недопустимой операции`,
      );

      // Дополнительная гарантия: даже минуя валидацию, исполнитель не выполнит операцию.
      assert.throws(
        () => evaluateTransform(expression, {}),
        (error) => error instanceof TransformEvaluationError && error.reason === "unknown_operation",
      );
    }
  });

  it("вложенные запрещённые операции ловятся на любой глубине AST", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i += 1) {
      const op = pick(rng, FORBIDDEN_OPS);
      const malicious = {
        op: "if",
        cond: { op: "lit", value: true },
        then: {
          op: "map",
          array: { op: "lit", value: [1] },
          as: "x",
          body: { op, args: [{ op: "var", name: "x" }] },
        },
        else: { op: "input" },
      };
      const result = validateTransformExpression(malicious);
      assert.equal(result.valid, false, `Вложенная "${op}" должна быть отвергнута`);
    }
  });

  it("ни один сгенерированный валидный вход не читает время/ГСЧ и не даёт побочных эффектов", () => {
    const rng = mulberry32(42);
    const originalRandom = Math.random;
    const originalNow = Date.now;
    const originalDateNow = Date.prototype.getTime;

    // Инструментирование: любое обращение к времени/ГСЧ во время вычисления — провал.
    Math.random = () => {
      throw new Error("Transform обратился к Math.random — грамматика не должна иметь ГСЧ");
    };
    Date.now = () => {
      throw new Error("Transform обратился к Date.now — грамматика не должна читать время");
    };

    try {
      for (let i = 0; i < 500; i += 1) {
        const expression = randomValidExpression(rng, 3 + Math.floor(rng() * 3), []);
        const validation = validateTransformExpression(expression);
        assert.equal(validation.valid, true, `Сгенерированное выражение должно быть валидным: ${JSON.stringify(validation.errors)}`);

        const input = { order: { total: i }, numbers: [i, i + 1] };

        // Контролируемая ошибка вычислителя (например, to_number над строкой) —
        // штатный детерминированный исход, НЕ побочный эффект. Обращение же к
        // Math.random/Date.now бросило бы обычный Error (стабы выше) и провалило бы тест.
        let first;
        try {
          first = evaluateTransform(expression, input);
        } catch (error) {
          assert.ok(
            error instanceof TransformEvaluationError,
            `Ожидалась контролируемая ошибка вычислителя, получено: ${error?.message}`,
          );
          continue;
        }

        const second = evaluateTransform(expression, input);
        // Результат — чистый JSON (сериализуем, без функций/undefined/циклов).
        assert.doesNotThrow(() => JSON.stringify(first));
        // Детерминизм/идемпотентность: одинаковый вход → одинаковый выход.
        assert.deepEqual(first, second);
      }
    } finally {
      Math.random = originalRandom;
      Date.now = originalNow;
      Date.prototype.getTime = originalDateNow;
    }
  });

  it("исполнение не мутирует входной объект (нет побочных эффектов на input)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i += 1) {
      const expression = randomValidExpression(rng, 3, []);
      const input = { order: { total: 5 }, numbers: [1, 2, 3] };
      const before = JSON.stringify(input);
      try {
        evaluateTransform(expression, input);
      } catch (error) {
        assert.ok(error instanceof TransformEvaluationError, `Неожиданная ошибка: ${error?.message}`);
      }
      assert.equal(JSON.stringify(input), before, "input не должен мутировать");
    }
  });

  it("лимиты ресурсов соблюдаются: превышение глубины/узлов AST отвергается валидацией", () => {
    // Слишком глубокое дерево — отвергается на ВАЛИДАЦИИ (не на исполнении).
    let deep: any = { op: "input" };
    for (let i = 0; i < TRANSFORM_DEFAULT_LIMITS.maxAstDepth + 5; i += 1) {
      deep = { op: "not", args: [deep] };
    }
    const depthResult = validateTransformExpression(deep);
    assert.equal(depthResult.valid, false);
    assert.ok(depthResult.errors.some((e) => /глубины AST/.test(e.message)));

    // Слишком много узлов — отвергается на ВАЛИДАЦИИ.
    const many = { op: "add", args: Array.from({ length: TRANSFORM_DEFAULT_LIMITS.maxAstNodes + 10 }, () => ({ op: "lit", value: 1 })) };
    const nodesResult = validateTransformExpression(many);
    assert.equal(nodesResult.valid, false);
    assert.ok(nodesResult.errors.some((e) => /узлов AST/.test(e.message)));
  });

  it("лимиты времени/размера соблюдаются на ИСПОЛНЕНИИ без ослабления валидации", () => {
    // Бюджет шагов ограничивает время (грамматика без неограниченных циклов).
    const heavy = {
      op: "map",
      array: { op: "input" },
      as: "outer",
      body: { op: "map", array: { op: "input" }, as: "inner", body: { op: "add", args: [{ op: "var", name: "outer" }, { op: "var", name: "inner" }] } },
    };
    assert.throws(
      () => evaluateTransform(heavy, Array.from({ length: 500 }, (_, i) => i), { maxSteps: 1000 }),
      (error) => error instanceof TransformEvaluationError && error.reason === "step_budget_exceeded",
    );

    // Размер результата ограничен.
    const big = { op: "map", array: { op: "input" }, as: "n", body: { op: "lit", value: "xxxxxxxxxxxxxxxx" } };
    assert.throws(
      () => evaluateTransform(big, Array.from({ length: 1000 }, (_, i) => i), { maxResultBytes: 256 }),
      (error) => error instanceof TransformEvaluationError && error.reason === "result_too_large",
    );
  });

  it("случайные некорректные узлы (не-объекты/битый op) отвергаются, а не исполняются", () => {
    const rng = mulberry32(99);
    const junk = [null, undefined, 42, "op", true, [], { noOp: true }, { op: 123 }, { op: "" }, { op: {} }];
    for (let i = 0; i < 100; i += 1) {
      const node = pick(rng, junk);
      const result = validateTransformExpression(node);
      assert.equal(result.valid, false, `Мусорный узел ${JSON.stringify(node)} должен быть невалиден`);
    }
  });
});
