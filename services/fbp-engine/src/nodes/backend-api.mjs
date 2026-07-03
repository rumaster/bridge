import {
  FBP_BACKEND_API_METHODS,
  TRANSFORM_DEFAULT_LIMITS,
} from "../../../../packages/contracts/src/c5.mjs";
import { WorkflowExecutionError } from "../core/errors.mjs";
import { evaluateTransform } from "../transform/evaluator.mjs";
import { validateTransformExpression } from "../transform/validate-expression.mjs";

const METHODS = new Set(FBP_BACKEND_API_METHODS);
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const FORBIDDEN_CONFIG_KEYS = new Set(["organization_id", "organizationId", "actor_user_id", "context"]);

/**
 * Узел Backend API (ТЗ §13.5, §13.13-п.2) — ЕДИНСТВЕННЫЙ санкционированный способ
 * менять данные. Формирует вызов публичного Backend API от имени арендатора и
 * актора ИЗ контекста экземпляра; `organization_id` берётся только из контекста
 * и не может быть переопределён конфигурацией узла (§13.13-п.4). Тело и query
 * собираются безопасным Transform-вычислителем над собранным `input`.
 */
export const backendApiNode = {
  type: "backend-api",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    if (!isRecord(config)) {
      errors.push({ path, message: "Узел backend-api требует объект config." });
      return;
    }

    rejectTenantOverride(config, path, errors);

    if (typeof config.method !== "string" || !METHODS.has(config.method)) {
      errors.push({
        path: `${path}.method`,
        message: `method должен быть одним из ${[...METHODS].join(", ")}.`,
      });
    }

    validateApiPath(config.path, `${path}.path`, errors);

    if (config.body !== undefined) {
      collectTransformErrors(config.body, `${path}.body`, errors, limits);
    }
    if (config.query !== undefined) {
      collectTransformErrors(config.query, `${path}.query`, errors, limits);
    }
    if (config.timeout_ms !== undefined) {
      if (!Number.isInteger(config.timeout_ms) || config.timeout_ms < 1 || config.timeout_ms > 30000) {
        errors.push({
          path: `${path}.timeout_ms`,
          message: "timeout_ms должен быть целым числом от 1 до 30000.",
        });
      }
    }
  },

  async execute({ node, input, ctx, backendClient, limits = TRANSFORM_DEFAULT_LIMITS }) {
    const config = node.config;
    const method = config.method;
    const path = resolvePath(config.path, input);
    const query = config.query === undefined ? {} : asQuery(evaluateTransform(config.query, input, limits));
    const body = method === "GET"
      ? null
      : config.body === undefined
        ? input
        : evaluateTransform(config.body, input, limits);

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
      output: response,
      port: "out",
      log: {
        backend_request: { method, path },
        status_code: response?.status_code ?? null,
      },
    };
  },
};

function rejectTenantOverride(config, path, errors) {
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      errors.push({
        path: `${path}.${key}`,
        message: "Узел не может задавать арендатора/актора/контекст — они берутся из контекста экземпляра (§13.13-п.4).",
      });
    }
  }
}

function validateApiPath(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "path должен быть непустой строкой." });
    return;
  }
  if (value !== "/api/v1" && !value.startsWith("/api/v1/")) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
  const placeholders = value.match(PLACEHOLDER);
  if (placeholders) {
    for (const raw of placeholders) {
      const name = raw.slice(1, -1);
      if (name === "") {
        errors.push({ path, message: "Пустой плейсхолдер {} в path недопустим." });
      }
    }
  }
}

function collectTransformErrors(expression, path, errors, limits) {
  const result = validateTransformExpression(expression, { limits });
  if (!result.valid) {
    for (const error of result.errors) {
      errors.push({ path: `${path}${error.path.startsWith("$") ? error.path.slice(1) : `.${error.path}`}`, message: error.message });
    }
  }
}

function resolvePath(template, input) {
  return template.replace(PLACEHOLDER, (_, key) => {
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
  if (!isRecord(value)) {
    throw new WorkflowExecutionError(
      "invalid_query",
      "query-выражение узла backend-api должно вычисляться в объект.",
      { nodeType: "backend-api" },
    );
  }
  const query = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) {
      continue;
    }
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new WorkflowExecutionError(
        "invalid_query",
        `Значение query-параметра "${key}" должно быть скаляром.`,
        { nodeType: "backend-api" },
      );
    }
    query[key] = item;
  }
  return query;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
