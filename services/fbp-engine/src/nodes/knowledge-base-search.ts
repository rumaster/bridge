const DEFAULT_PATH = "/api/v1/ai/knowledge-base/search";

/**
 * Узел поиска в Knowledge Base (ТЗ §13.7, §13.13-п.1). Нейтрален и идёт ТОЛЬКО
 * через Backend (канал C3) — прямого доступа к KB/векторному хранилищу у движка
 * нет (§13.13-п.3).
 *
 * Ревизия 2026-07-15: вместо строки `query` из Transform-выражения у узла два
 * data-входа — `keys` (ключевые фразы) и `tags`, — и выход `documents`. Это
 * ложится на редизайн KB от 2026-07-14, где эмбеддинг считается по каждой
 * ключевой фразе, а не по контенту.
 */
export const knowledgeBaseSearchNode = {
  type: "knowledge-base-search",

  validate(config, { path, errors }) {
    validateApiPath(config?.path, `${path}.path`, errors);
    if (config?.top_k !== undefined && (!Number.isInteger(config.top_k) || config.top_k < 1 || config.top_k > 100)) {
      errors.push({ path: `${path}.top_k`, message: "top_k должен быть целым числом от 1 до 100." });
    }
  },

  async execute({ node, input, ctx, backendClient }) {
    const config = node.config ?? {};
    const body = {
      keys: asStringArray(input.keys),
      tags: asStringArray(input.tags),
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
      outputs: { documents: asObjectArray(response) },
      log: {
        kb_path: config.path ?? DEFAULT_PATH,
        keys: body.keys.length,
        status_code: response?.status_code ?? null,
      },
    };
  },
};

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "");
}

/** Ответ Backend может быть массивом документов либо конвертом с полем documents. */
function asObjectArray(response) {
  if (Array.isArray(response)) return response;
  const body = response?.body ?? response;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.documents)) return body.documents;
  return [];
}

function validateApiPath(value, path, errors) {
  if (value === undefined) return;
  if (typeof value !== "string" || (value !== "/api/v1" && !value.startsWith("/api/v1/"))) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
}
