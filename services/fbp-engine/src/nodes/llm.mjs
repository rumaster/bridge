import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.mjs";
import { evaluateTransform } from "../transform/evaluator.mjs";
import { validateTransformExpression } from "../transform/validate-expression.mjs";

const DEFAULT_PATH = "/api/v1/ai/llm/completions";

/**
 * Узел вызова LLM (ТЗ §13.6, §13.13-п.1). Нейтрален и идёт ТОЛЬКО через Backend
 * (канал C3): прямого доступа к AI-сервису у движка нет (§13.13-п.3). Промпт и
 * параметры собираются безопасным Transform-вычислителем над `input`; арендатор
 * и актор берутся из контекста экземпляра.
 */
export const llmNode = {
  type: "llm",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config) || config.prompt === undefined) {
      errors.push({ path: `${path}.prompt`, message: "Узел llm требует поле prompt (Transform-выражение)." });
      return;
    }
    validateApiPath(config.path, `${path}.path`, errors);
    pushTransformErrors(config.prompt, `${path}.prompt`, errors, limits);
    if (config.params !== undefined) {
      pushTransformErrors(config.params, `${path}.params`, errors, limits);
    }
  },

  async execute({ node, input, ctx, backendClient, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const config = node.config;
    const body = {
      prompt: evaluateTransform(config.prompt, input, limits),
      params: config.params === undefined ? {} : evaluateTransform(config.params, input, limits),
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
      log: { llm_path: config.path ?? DEFAULT_PATH, status_code: response?.status_code ?? null },
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
