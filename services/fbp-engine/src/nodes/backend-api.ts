import { FBP_BACKEND_API_METHODS, configPortRows } from "@bridge/contracts/c5-workflow";
import { WorkflowExecutionError } from "../core/errors.js";

const METHODS = new Set(FBP_BACKEND_API_METHODS);
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const RESERVED_INPUT_PORTS = new Set(["body", "query"]);

/**
 * Узел Backend API (ТЗ §13.5, §13.13-п.2) — ЕДИНСТВЕННЫЙ санкционированный способ
 * менять данные. Вызывает публичный Backend API от имени арендатора и актора ИЗ
 * контекста экземпляра; `organization_id` берётся только оттуда и не может быть
 * переопределён конфигурацией узла (§13.13-п.4) — это проверяет контракт C5.
 *
 * Ревизия 2026-07-15: тело и query больше не Transform-выражения, а data-входы.
 * Порт `body` — тело запроса, `query` — объект query-параметров, остальные входы
 * подставляются в плейсхолдеры пути (`/api/v1/clients/{id}` берёт вход `id`).
 * Операция выбирается в редакторе из каталога, а `method`/`path` — снимок
 * выбранной операции в конфиге.
 */
export const backendApiNode = {
  type: "backend-api",

  validate(config, { path, errors }) {
    if (typeof config?.method !== "string" || !METHODS.has(config.method)) {
      errors.push({
        path: `${path}.method`,
        message: `method должен быть одним из ${[...METHODS].join(", ")}.`,
      });
    }
    validateApiPath(config?.path, `${path}.path`, errors);
    if (config?.timeout_ms !== undefined) {
      if (!Number.isInteger(config.timeout_ms) || config.timeout_ms < 1 || config.timeout_ms > 30000) {
        errors.push({ path: `${path}.timeout_ms`, message: "timeout_ms должен быть целым числом от 1 до 30000." });
      }
    }
    // Плейсхолдеры пути обязаны иметь одноимённые входные порты, иначе узел
    // гарантированно упадёт в рантайме — ловим это на сохранении.
    const declared = new Set(configPortRows(config?.inputs).map((row) => row.name));
    for (const name of pathPlaceholders(config?.path)) {
      if (!declared.has(name)) {
        errors.push({
          path: `${path}.inputs`,
          message: `Плейсхолдер {${name}} в path требует одноимённый входной порт.`,
        });
      }
    }
  },

  async execute({ node, input, ctx, backendClient }) {
    const config = node.config ?? {};
    const method = config.method;
    const path = resolvePath(config.path, input);
    const query = asQuery(input.query);
    const body = method === "GET" ? null : resolveBody(input);

    const response = await backendClient.call({
      method,
      path,
      query,
      body,
      timeout_ms: config.timeout_ms ?? null,
      // Арендатор/актор ТОЛЬКО из контекста экземпляра — узел их не задаёт.
      context: ctx.toCallContext(),
    });

    return {
      outputs: resolveOutputs(config, response),
      log: {
        backend_request: { method, path },
        operation_id: config.operation_id ?? null,
        status_code: response?.status_code ?? null,
      },
    };
  },
};

/** Выходы раскладываются по объявленным портам; без объявления — весь ответ. */
function resolveOutputs(config, response) {
  const rows = configPortRows(config.outputs);
  if (rows.length === 0) return { response };
  const body = response?.body ?? response;
  const outputs: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.name === "response") {
      outputs.response = response;
      continue;
    }
    if (row.name === "status_code") {
      outputs.status_code = response?.status_code ?? null;
      continue;
    }
    outputs[row.name] =
      body !== null && typeof body === "object" && Object.hasOwn(body, row.name) ? body[row.name] : body;
  }
  return outputs;
}

/** Тело — порт `body`; если он не подключён, телом становится всё остальное. */
function resolveBody(input) {
  if (Object.hasOwn(input, "body")) return input.body;
  const rest = {};
  for (const [key, value] of Object.entries(input)) {
    if (!RESERVED_INPUT_PORTS.has(key)) rest[key] = value;
  }
  return rest;
}

function pathPlaceholders(template) {
  if (typeof template !== "string") return [];
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => name !== "");
}

function validateApiPath(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "path должен быть непустой строкой." });
    return;
  }
  if (value !== "/api/v1" && !value.startsWith("/api/v1/")) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
  if (/\{\}/.test(value)) {
    errors.push({ path, message: "Пустой плейсхолдер {} в path недопустим." });
  }
}

function resolvePath(template, input) {
  return String(template).replace(PLACEHOLDER, (_, key) => {
    const value = input?.[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new WorkflowExecutionError(
        "invalid_path_parameter",
        `Плейсхолдер {${key}} в path требует строковое или числовое значение во входе узла.`,
        { nodeType: "backend-api" },
      );
    }
    return encodeURIComponent(String(value));
  });
}

function asQuery(value) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new WorkflowExecutionError("invalid_query", "Вход query узла backend-api должен быть объектом.", {
      nodeType: "backend-api",
    });
  }
  const query = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new WorkflowExecutionError("invalid_query", `Значение query-параметра "${key}" должно быть скаляром.`, {
        nodeType: "backend-api",
      });
    }
    query[key] = item;
  }
  return query;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
