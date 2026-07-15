import { getBackendApiOperation } from "@bridge/contracts/backend-api-catalog";
import { configPortRows } from "@bridge/contracts/c5-workflow";
import { WorkflowExecutionError } from "../core/errors.js";

/**
 * Узел вызова LLM (ТЗ §13.6, §13.13-п.1). Нейтрален и идёт ТОЛЬКО через Backend
 * (канал C3): прямого доступа к AI-сервису у движка нет (§13.13-п.3). Арендатор и
 * актор берутся из контекста экземпляра.
 *
 * Ревизия 2026-07-15: промпт задаётся в `config.prompt` как текст с
 * подстановками `{порт}` из входов, а не Transform-выражением.
 *
 * Ревизия 2026-07-15 (вторая): `config.path` удалён. Раньше путь был свободной
 * строкой с проверкой «начинается с /api/v1», а дефолт `/api/v1/ai/llm/completions`
 * в OpenAPI отсутствовал — то есть узел в бою получал 404. Теперь операция
 * фиксирована каталогом, сгенерированным из OpenAPI: маршрут не может разъехаться
 * с API молча, а витрина `workflow_backend_api_allowlist` решает, разрешён ли вызов
 * схемам вообще.
 */
const OPERATION_ID = "AiIntegrationController_completeLlm_v1";

export const llmNode = {
  type: "llm",

  validate(config, { path, errors }) {
    if (typeof config?.prompt !== "string" || config.prompt.trim() === "") {
      errors.push({ path: `${path}.prompt`, message: "Узел llm требует непустой текст промпта." });
    }
  },

  async execute({ node, input, ctx, backendClient }) {
    const config = node.config ?? {};
    const operation = resolveOperation();

    const response = await backendClient.call({
      method: operation.method,
      path: operation.path,
      query: {},
      body: {
        prompt: interpolate(config.prompt, input),
        params: isRecord(config.params) ? config.params : {},
      },
      timeout_ms: config.timeout_ms ?? null,
      context: ctx.toCallContext(),
    });

    return {
      outputs: resolveOutputs(config, response),
      log: {
        operation_id: operation.operation_id,
        status_code: response?.status_code ?? null,
        // Заглушку от настоящей генерации отличает только этот признак: без него в
        // трассе не видно, ветвилась схема по ответу модели или по фолбэку.
        degraded: readBody(response)?.degraded ?? null,
      },
    };
  },
};

function resolveOperation() {
  const operation = getBackendApiOperation(OPERATION_ID);
  if (!operation) {
    throw new WorkflowExecutionError(
      "unknown_operation",
      `Вызова "${OPERATION_ID}" нет в каталоге Backend API.`,
      { nodeType: "llm" },
    );
  }
  return operation;
}

/** Подстановка `{порт}` значениями входов; неизвестный порт остаётся как есть. */
function interpolate(template, input) {
  return String(template ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (raw, key) => {
    if (!Object.hasOwn(input, key)) return raw;
    const value = input[key];
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

/**
 * Выходы раскладываются по объявленным портам. Без объявления — `text` (сам ответ
 * модели): это то, ради чего узел и вызывают. `raw` отдаёт конверт C4 целиком — он
 * нужен, когда схема ветвится по `degraded`.
 */
function resolveOutputs(config, response) {
  const body = readBody(response);
  const rows = configPortRows(config.outputs);
  if (rows.length === 0) return { text: completionText(body) };

  const outputs: Record<string, unknown> = {};
  for (const row of rows) {
    switch (row.name) {
      case "raw":
        outputs.raw = body;
        break;
      case "text":
        outputs.text = completionText(body);
        break;
      case "model":
        outputs.model = readCompletion(body)?.model ?? null;
        break;
      case "degraded":
        outputs.degraded = body?.degraded ?? null;
        break;
      default:
        outputs[row.name] =
          body !== null && Object.hasOwn(body, row.name) ? body[row.name] : null;
    }
  }
  return outputs;
}

function completionText(body) {
  const text = readCompletion(body)?.text;
  return typeof text === "string" ? text : "";
}

function readCompletion(body) {
  const completion = body?.completion;
  return completion !== null && typeof completion === "object" ? completion : null;
}

function readBody(response) {
  const body = response?.body ?? response;
  return body !== null && typeof body === "object" ? body : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
