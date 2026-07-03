import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.mjs";
import { evaluateTransform } from "../transform/evaluator.mjs";
import { validateTransformExpression } from "../transform/validate-expression.mjs";

const DEFAULT_PATH = "/api/v1/ai/knowledge-base/search";

/**
 * Узел поиска в Knowledge Base (ТЗ §13.7, §13.13-п.1). Нейтрален и идёт ТОЛЬКО
 * через Backend (канал C3) — прямого доступа к KB/векторному хранилищу у движка
 * нет (§13.13-п.3). Строка запроса собирается безопасным Transform-вычислителем.
 */
export const knowledgeBaseSearchNode = {
  type: "knowledge-base-search",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config) || config.query === undefined) {
      errors.push({ path: `${path}.query`, message: "Узел knowledge-base-search требует поле query (Transform-выражение)." });
      return;
    }
    validateApiPath(config.path, `${path}.path`, errors);
    pushTransformErrors(config.query, `${path}.query`, errors, limits);
    if (config.top_k !== undefined && (!Number.isInteger(config.top_k) || config.top_k < 1 || config.top_k > 100)) {
      errors.push({ path: `${path}.top_k`, message: "top_k должен быть целым числом от 1 до 100." });
    }
  },

  async execute({ node, input, ctx, backendClient, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const config = node.config;
    const body = {
      query: evaluateTransform(config.query, input, limits),
      top_k: config.top_k ?? 5,
    };
    const response = await backendClient.call({
      method: "POST",
      path: config.path ?? DEFAULT_PATH,
      query: {},
      body,
      timeout_ms: config.timeout_ms ?? null,
      context: ctx.toCallContext(),
    });
    return {
      output: response,
      port: "out",
      log: { kb_path: config.path ?? DEFAULT_PATH, status_code: response?.status_code ?? null },
    };
  },
};

function validateApiPath(value, path, errors) {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || (value !== "/api/v1" && !value.startsWith("/api/v1/"))) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
}

function pushTransformErrors(expression, path, errors, limits) {
  const result = validateTransformExpression(expression, { limits });
  for (const error of result.errors) {
    errors.push({ path: `${path}.${error.path}`, message: error.message });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
