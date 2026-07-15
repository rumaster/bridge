import { getBackendApiOperation } from "@bridge/contracts/backend-api-catalog";
import { WorkflowExecutionError } from "../core/errors.js";

/**
 * Узел поиска в Knowledge Base (ТЗ §13.7, §13.13-п.1). Нейтрален и идёт ТОЛЬКО
 * через Backend (канал C3) — прямого доступа к KB/векторному хранилищу у движка
 * нет (§13.13-п.3).
 *
 * Ревизия 2026-07-15: вместо строки `query` из Transform-выражения у узла два
 * data-входа — `keys` (ключевые фразы) и `tags`, — и выход `documents`. Это
 * ложится на редизайн KB от 2026-07-14, где эмбеддинг считается по каждой
 * ключевой фразе, а не по контенту.
 *
 * Ревизия 2026-07-15 (вторая): `config.path` удалён. Дефолт
 * `/api/v1/ai/knowledge-base/search` в OpenAPI отсутствовал — узел в бою получал
 * 404. Операция теперь фиксирована каталогом из OpenAPI. Эмбеддинг ключевых фраз
 * считает Backend: у движка нет LLM-провайдера и быть не должно.
 */
const OPERATION_ID = "KnowledgeSearchController_searchDocuments_v1";

export const knowledgeBaseSearchNode = {
  type: "knowledge-base-search",

  validate(config, { path, errors }) {
    if (config?.top_k !== undefined && (!Number.isInteger(config.top_k) || config.top_k < 1 || config.top_k > 100)) {
      errors.push({ path: `${path}.top_k`, message: "top_k должен быть целым числом от 1 до 100." });
    }
  },

  async execute({ node, input, ctx, backendClient }) {
    const config = node.config ?? {};
    const operation = getBackendApiOperation(OPERATION_ID);
    if (!operation) {
      throw new WorkflowExecutionError(
        "unknown_operation",
        `Вызова "${OPERATION_ID}" нет в каталоге Backend API.`,
        { nodeId: node.id, nodeType: "knowledge-base-search" },
      );
    }

    const body = {
      keys: asStringArray(input.keys),
      tags: asStringArray(input.tags),
      top_k: config.top_k ?? 5,
    };

    const response = await backendClient.call({
      method: operation.method,
      path: operation.path,
      query: {},
      body,
      timeout_ms: config.timeout_ms ?? null,
      context: ctx.toCallContext(),
    });

    return {
      outputs: { documents: asObjectArray(response) },
      log: {
        operation_id: operation.operation_id,
        keys: body.keys.length,
        tags: body.tags.length,
        status_code: response?.status_code ?? null,
      },
    };
  },
};

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "");
}

/** Ответ Backend — конверт `{ documents }`; массив принимается для совместимости. */
function asObjectArray(response) {
  if (Array.isArray(response)) return response;
  const body = response?.body ?? response;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.documents)) return body.documents;
  return [];
}
