import { Buffer } from "node:buffer";

import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.js";
import { evaluateTransformCode } from "../transform/code-sandbox.js";
import { evaluateTransform } from "../transform/evaluator.js";
import { validateTransformExpression } from "../transform/validate-expression.js";

/**
 * Transform Node (ТЗ §13.4, §13.13-п.5). По умолчанию исполняет
 * декларативное `expression`; при `mode: "code"` запускает JS-код в отдельном
 * sandbox-процессе. Оба режима видят только собранный `input`.
 */
export const transformNode = {
  type: "transform",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config)) {
      errors.push({ path, message: "Узел transform требует объект config." });
      return;
    }

    if (config.code !== undefined && config.mode !== "code") {
      errors.push({ path: `${path}.mode`, message: "Поле code доступно только при mode=\"code\"." });
      return;
    }

    const mode = config.mode ?? "expression";
    if (mode === "expression") {
      validateExpressionConfig(config, { path, errors, limits });
      return;
    }

    if (mode === "code") {
      validateCodeConfig(config, { path, errors, limits });
      return;
    }

    errors.push({ path: `${path}.mode`, message: "mode должен быть expression или code." });
  },

  async execute({ node, input, limits = TRANSFORM_DEFAULT_LIMITS }: any) {
    const mode = node.config.mode ?? "expression";
    const output = mode === "code"
      ? await evaluateTransformCode(node.config.code, input, limits)
      : evaluateTransform(node.config.expression, input, limits);
    return { output, port: "out" };
  },
};

function validateExpressionConfig(config, { path, errors, limits }) {
  if (config.expression === undefined) {
    errors.push({ path: `${path}.expression`, message: "Узел transform требует поле expression." });
    return;
  }

  const result = validateTransformExpression(config.expression, { limits });
  for (const error of result.errors) {
    errors.push({ path: `${path}.expression.${error.path}`, message: error.message });
  }
}

function validateCodeConfig(config, { path, errors, limits }) {
  if (typeof config.code !== "string" || config.code.trim() === "") {
    errors.push({ path: `${path}.code`, message: "mode=code требует непустое строковое поле code." });
    return;
  }

  const maxCodeLength = Number.isInteger(limits.maxCodeLength)
    ? limits.maxCodeLength
    : TRANSFORM_DEFAULT_LIMITS.maxCodeLength;
  if (Buffer.byteLength(config.code, "utf8") > maxCodeLength) {
    errors.push({ path: `${path}.code`, message: `code превышает лимит ${maxCodeLength} байт.` });
  }

  if (config.expression !== undefined) {
    errors.push({ path: `${path}.expression`, message: "mode=code не использует поле expression." });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
