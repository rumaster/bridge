import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.js";
import { evaluateTransform } from "../transform/evaluator.js";
import { validateTransformExpression } from "../transform/validate-expression.js";

/**
 * Transform Node (ТЗ §13.4, §13.13-п.5). Исполняет валидированное на этапе
 * сохранения декларативное выражение над собранным `input`. Изоляция «по
 * построению»: вычислитель видит ТОЛЬКО `input`, а грамматика не содержит
 * операций доступа к среде/сети/ФС/секретам/времени/ГСЧ/произвольному коду.
 */
export const transformNode = {
  type: "transform",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config) || config.expression === undefined) {
      errors.push({ path: `${path}.expression`, message: "Узел transform требует поле expression." });
      return;
    }
    const result = validateTransformExpression(config.expression, { limits });
    for (const error of result.errors) {
      errors.push({ path: `${path}.expression.${error.path}`, message: error.message });
    }
  },

  execute({ node, input, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const output = evaluateTransform(node.config.expression, input, limits);
    return { output, port: "out" };
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
