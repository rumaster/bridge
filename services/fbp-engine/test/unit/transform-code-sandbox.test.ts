import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TransformEvaluationError } from "../../src/transform/errors.js";
import { evaluateTransformCode } from "../../src/transform/code-sandbox.js";

describe("Transform Node — режим code в изолированном исполнителе (§13.4)", () => {
  it("исполняет произвольный JavaScript только над input", async () => {
    const result = await evaluateTransformCode(
      `
        const total = input.items.reduce((sum, item) => sum + item.price, 0);
        return { total, label: input.prefix + ":" + total };
      `,
      { prefix: "sum", items: [{ price: 10 }, { price: 15 }] },
      { codeTimeoutMs: 500, maxResultBytes: 4096 },
    );

    assert.deepEqual(result, { total: 25, label: "sum:25" });
  });

  it("не отдаёт code-режиму process/env/require", async () => {
    await assert.rejects(
      () =>
        evaluateTransformCode(
          `
            return {
              processEnv: process.env,
              requireType: typeof require
            };
          `,
          {},
          { codeTimeoutMs: 500 },
        ),
      (error) =>
        error instanceof TransformEvaluationError &&
        error.reason === "code_execution_failed" &&
        /process is not defined/.test(error.message),
    );
  });

  it("блокирует Function/constructor escape внутри sandbox", async () => {
    await assert.rejects(
      () =>
        evaluateTransformCode(
          `
            return globalThis.constructor.constructor("return process")();
          `,
          {},
          { codeTimeoutMs: 500 },
        ),
      (error) =>
        error instanceof TransformEvaluationError &&
        error.reason === "code_execution_failed" &&
        /Code generation from strings disallowed|process is not defined/.test(error.message),
    );
  });

  it("не отдаёт code-режиму системное время и ГСЧ", async () => {
    const result = await evaluateTransformCode(
      "return { dateType: typeof Date, randomType: typeof Math.random, max: Math.max(input.a, input.b) };",
      { a: 2, b: 7 },
      { codeTimeoutMs: 500 },
    );

    assert.deepEqual(result, { dateType: "undefined", randomType: "undefined", max: 7 });
  });

  it("останавливает бесконечный цикл по timeout и не роняет основной процесс", async () => {
    await assert.rejects(
      () => evaluateTransformCode("while (true) {}", {}, { codeTimeoutMs: 50 }),
      (error) => error instanceof TransformEvaluationError && error.reason === "code_timeout",
    );
  });

  it("отклоняет несериализуемый результат", async () => {
    await assert.rejects(
      () => evaluateTransformCode("return () => input;", { value: 1 }, { codeTimeoutMs: 500 }),
      (error) =>
        error instanceof TransformEvaluationError &&
        error.reason === "result_not_serializable",
    );
  });
});
