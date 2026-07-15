import { configPortRows } from "@bridge/contracts/c5-workflow";

const DEFAULT_PATH = "/api/v1/ai/llm/completions";

/**
 * Узел вызова LLM (ТЗ §13.6, §13.13-п.1). Нейтрален и идёт ТОЛЬКО через Backend
 * (канал C3): прямого доступа к AI-сервису у движка нет (§13.13-п.3). Арендатор и
 * актор берутся из контекста экземпляра.
 *
 * Ревизия 2026-07-15: промпт задаётся в `config.prompt` как текст с
 * подстановками `{порт}` из входов, а не Transform-выражением. Выходы
 * раскладываются по объявленным портам (`raw` — ответ целиком).
 */
export const llmNode = {
  type: "llm",

  validate(config, { path, errors }) {
    if (typeof config?.prompt !== "string" || config.prompt.trim() === "") {
      errors.push({ path: `${path}.prompt`, message: "Узел llm требует непустой текст промпта." });
    }
    validateApiPath(config?.path, `${path}.path`, errors);
  },

  async execute({ node, input, ctx, backendClient }) {
    const config = node.config ?? {};
    const body = {
      prompt: interpolate(config.prompt, input),
      params: isRecord(config.params) ? config.params : {},
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
      outputs: resolveOutputs(config, response),
      log: { llm_path: config.path ?? DEFAULT_PATH, status_code: response?.status_code ?? null },
    };
  },
};

/** Подстановка `{порт}` значениями входов; неизвестный порт остаётся как есть. */
function interpolate(template, input) {
  return String(template ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (raw, key) => {
    if (!Object.hasOwn(input, key)) return raw;
    const value = input[key];
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

function resolveOutputs(config, response) {
  const rows = configPortRows(config.outputs);
  const body = response?.body ?? response;
  if (rows.length === 0) return { raw: body };
  const outputs: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.name === "raw") {
      outputs.raw = body;
      continue;
    }
    outputs[row.name] =
      body !== null && typeof body === "object" && Object.hasOwn(body, row.name) ? body[row.name] : body;
  }
  return outputs;
}

function validateApiPath(value, path, errors) {
  if (value === undefined) return;
  if (typeof value !== "string" || (value !== "/api/v1" && !value.startsWith("/api/v1/"))) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
