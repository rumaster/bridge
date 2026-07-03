import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.mjs";
import { evaluateTransform } from "../transform/evaluator.mjs";
import { validateTransformExpression } from "../transform/validate-expression.mjs";

/**
 * Узел ветвления (ТЗ §13.4). Вычисляет булево выражение над `input` безопасным
 * Transform-вычислителем и выбирает выходной порт "true"/"false" — маршрутизация
 * графа. Сам вход прозрачно передаётся дальше как результат узла.
 */
export const branchNode = {
  type: "branch",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config) || config.condition === undefined) {
      errors.push({ path: `${path}.condition`, message: "Узел branch требует поле condition." });
      return;
    }
    const result = validateTransformExpression(config.condition, { limits });
    for (const error of result.errors) {
      errors.push({ path: `${path}.condition.${error.path}`, message: error.message });
    }
  },

  execute({ node, input, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const condition = evaluateTransform(node.config.condition, input, limits);
    const port = Boolean(condition) ? "true" : "false";
    return { output: input, port, log: { condition: port } };
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
