import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.js";
import { evaluateTransform } from "../transform/evaluator.js";
import { validateTransformExpression } from "../transform/validate-expression.js";

/**
 * Узел ожидания внешнего события (ТЗ §13.4, §13.13-п.1). Переводит экземпляр в
 * состояние «waiting»: исполнение приостанавливается до прихода события нужного
 * типа. Инициировать Workflow движок НЕ может (§6.13) — узел лишь описывает,
 * какого события ждёт, а возобновление выполняет Backend.
 */
export const waitEventNode = {
  type: "wait-event",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config) || typeof config.event_type !== "string" || config.event_type.trim() === "") {
      errors.push({ path: `${path}.event_type`, message: "Узел wait-event требует непустой event_type." });
    }
    if (config.correlation !== undefined) {
      const result = validateTransformExpression(config.correlation, { limits });
      for (const error of result.errors) {
        errors.push({ path: `${path}.correlation.${error.path}`, message: error.message });
      }
    }
    if (config.timeout_ms !== undefined && (!Number.isInteger(config.timeout_ms) || config.timeout_ms < 1)) {
      errors.push({ path: `${path}.timeout_ms`, message: "timeout_ms должен быть положительным целым числом." });
    }
  },

  execute({ node, input, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const config = node.config;
    const correlation = config.correlation === undefined
      ? null
      : evaluateTransform(config.correlation, input, limits);
    const wait = {
      event_type: config.event_type,
      correlation,
      ...(config.timeout_ms ? { timeout_ms: config.timeout_ms } : {}),
    };
    return {
      output: input,
      port: "out",
      waiting: true,
      wait,
      log: { awaiting_event: config.event_type },
    };
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
