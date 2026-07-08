import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.js";

export const C5_VERSION = "1.0.0";

export const WORKFLOW_INSTANCE_STATUSES = Object.freeze([
  "created",
  "started",
  "running",
  "waiting",
  "callback_recorded",
  "completed",
  "failed",
  "cancelled",
  "degraded",
]);

export const WORKFLOW_STATE_CHANGED_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/workflow-state-changed.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function createWorkflowStateChangedEvent({
  eventId,
  organizationId,
  workflowId,
  workflowVersionId,
  instanceId,
  previousStatus = null,
  status,
  changedAt = new Date().toISOString(),
  reason,
}) {
  if (!WORKFLOW_INSTANCE_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported workflow instance status: ${status}`);
  }

  if (
    previousStatus !== null &&
    !WORKFLOW_INSTANCE_STATUSES.includes(previousStatus)
  ) {
    throw new TypeError(`Unsupported previous workflow instance status: ${previousStatus}`);
  }

  return {
    contract: "C7.WorkflowStateChangedEvent",
    version: C5_VERSION,
    event: "workflow.state_changed",
    event_id: eventId,
    organization_id: organizationId,
    workflow_id: workflowId,
    workflow_version_id: workflowVersionId,
    instance_id: instanceId,
    previous_status: previousStatus,
    status,
    changed_at: changedAt,
    ...(reason ? { reason } : {}),
  };
}

export function validateWorkflowStateChangedEvent(event) {
  return validateJsonSchema(event, WORKFLOW_STATE_CHANGED_EVENT_SCHEMA);
}

// ---------------------------------------------------------------------------
// C5 — нейтральный набор узлов FBP Engine (ТЗ §13.13-п.1) и грамматика
// безопасного Transform Node (ТЗ §13.4). Каталог узлов и whitelist операций —
// единый источник истины (мастер §7): движок `services/fbp-engine` импортирует
// эти определения, а контрактные/юнит-тесты проверяют отсутствие дрейфа.
// Проводной контракт C5 не меняется — это аддитивные определения данных,
// C5_VERSION остаётся "1.0.0".
// ---------------------------------------------------------------------------

export {
  FBP_NODE_TYPE_DEFINITIONS,
  FBP_NODE_TYPES,
  FBP_PORT_TYPES,
  WORKFLOW_SCHEMA_VERSION,
  arePortTypesCompatible,
  getFbpNodePortDefinition,
  getFbpNodeTypeDefinition,
} from "./c5-workflow.js";
export type {
  FbpNodePortDefinition,
  FbpNodePrimaryFieldDefinition,
  FbpNodeType,
  FbpNodeTypeDefinition,
  FbpPortDirection,
  FbpPortType,
} from "./c5-workflow.js";

/** HTTP-методы, доступные узлу Backend API (совпадают с DTO C5). */
export const FBP_BACKEND_API_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Источники данных для входных портов узла (декларативная «проводка» графа).
 * Разрешает исполнителю собрать `input` узла из Execution Context, при этом сам
 * Transform Node видит ТОЛЬКО собранный `input`, а не весь контекст (§13.4).
 */
export const FBP_INPUT_SOURCE_KINDS = Object.freeze([
  "params", // входные параметры Workflow (Parameters, §13.4)
  "node", // результат ранее исполненного узла
  "const", // литеральная константа схемы
]);

/**
 * Структурные операции грамматики Transform Node. Задают форму AST и не
 * являются вызовами функций (у них собственные поля вместо `args`).
 */
export const TRANSFORM_STRUCTURAL_OPERATIONS = Object.freeze([
  "lit", // { op:"lit", value } — литерал (только JSON-значения)
  "input", // { op:"input" } — весь вход узла
  "var", // { op:"var", name } — лексическая переменная map/filter/reduce
  "get", // { op:"get", object, path:[...] } — доступ по статическому пути
  "if", // { op:"if", cond, then, else } — условное выражение
  "map", // { op:"map", array, as, body } — отображение массива
  "filter", // { op:"filter", array, as, body } — фильтрация массива
  "reduce", // { op:"reduce", array, as, acc, init, body } — свёртка массива
]);

/**
 * Функциональные операции грамматики Transform Node с описанием арности
 * (`minArgs`/`maxArgs`). ГСЧ, системное время, сеть, ФС, секреты и доступ к
 * среде отсутствуют «по построению»: соответствующих операций в грамматике нет
 * (ТЗ §13.4). Операции над датами детерминированы и работают только над явно
 * переданными значениями (нет операции «now»).
 */
export const TRANSFORM_FUNCTION_OPERATIONS = Object.freeze({
  // Арифметика над числами
  add: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER, category: "arithmetic" },
  sub: { minArgs: 2, maxArgs: 2, category: "arithmetic" },
  mul: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER, category: "arithmetic" },
  div: { minArgs: 2, maxArgs: 2, category: "arithmetic" },
  mod: { minArgs: 2, maxArgs: 2, category: "arithmetic" },
  neg: { minArgs: 1, maxArgs: 1, category: "arithmetic" },
  abs: { minArgs: 1, maxArgs: 1, category: "arithmetic" },
  pow: { minArgs: 2, maxArgs: 2, category: "arithmetic" },
  floor: { minArgs: 1, maxArgs: 1, category: "arithmetic" },
  ceil: { minArgs: 1, maxArgs: 1, category: "arithmetic" },
  round: { minArgs: 1, maxArgs: 1, category: "arithmetic" },
  min: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "arithmetic" },
  max: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "arithmetic" },
  to_number: { minArgs: 1, maxArgs: 1, category: "arithmetic" },

  // Сравнения → boolean
  eq: { minArgs: 2, maxArgs: 2, category: "comparison" },
  ne: { minArgs: 2, maxArgs: 2, category: "comparison" },
  lt: { minArgs: 2, maxArgs: 2, category: "comparison" },
  lte: { minArgs: 2, maxArgs: 2, category: "comparison" },
  gt: { minArgs: 2, maxArgs: 2, category: "comparison" },
  gte: { minArgs: 2, maxArgs: 2, category: "comparison" },

  // Логика
  and: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "logic" },
  or: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "logic" },
  not: { minArgs: 1, maxArgs: 1, category: "logic" },
  coalesce: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "logic" },

  // Предикаты типов
  is_null: { minArgs: 1, maxArgs: 1, category: "type" },
  is_number: { minArgs: 1, maxArgs: 1, category: "type" },
  is_string: { minArgs: 1, maxArgs: 1, category: "type" },
  is_boolean: { minArgs: 1, maxArgs: 1, category: "type" },
  is_array: { minArgs: 1, maxArgs: 1, category: "type" },
  is_object: { minArgs: 1, maxArgs: 1, category: "type" },

  // Строки
  concat: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "string" },
  upper: { minArgs: 1, maxArgs: 1, category: "string" },
  lower: { minArgs: 1, maxArgs: 1, category: "string" },
  trim: { minArgs: 1, maxArgs: 1, category: "string" },
  split: { minArgs: 2, maxArgs: 2, category: "string" },
  replace: { minArgs: 3, maxArgs: 3, category: "string" },
  substring: { minArgs: 3, maxArgs: 3, category: "string" },
  str_includes: { minArgs: 2, maxArgs: 2, category: "string" },
  starts_with: { minArgs: 2, maxArgs: 2, category: "string" },
  ends_with: { minArgs: 2, maxArgs: 2, category: "string" },
  to_string: { minArgs: 1, maxArgs: 1, category: "string" },

  // Общая длина (строка или массив)
  length: { minArgs: 1, maxArgs: 1, category: "collection" },

  // Массивы
  join: { minArgs: 2, maxArgs: 2, category: "array" },
  slice: { minArgs: 3, maxArgs: 3, category: "array" },
  array_includes: { minArgs: 2, maxArgs: 2, category: "array" },
  array_concat: {
    minArgs: 1,
    maxArgs: Number.MAX_SAFE_INTEGER,
    category: "array",
  },
  first: { minArgs: 1, maxArgs: 1, category: "array" },
  last: { minArgs: 1, maxArgs: 1, category: "array" },
  reverse: { minArgs: 1, maxArgs: 1, category: "array" },
  unique: { minArgs: 1, maxArgs: 1, category: "array" },
  flatten: { minArgs: 1, maxArgs: 1, category: "array" },

  // Объекты
  keys: { minArgs: 1, maxArgs: 1, category: "object" },
  values: { minArgs: 1, maxArgs: 1, category: "object" },
  entries: { minArgs: 1, maxArgs: 1, category: "object" },
  from_entries: { minArgs: 1, maxArgs: 1, category: "object" },
  merge: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, category: "object" },
  pick: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER, category: "object" },
  omit: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER, category: "object" },
  has: { minArgs: 2, maxArgs: 2, category: "object" },

  // Даты (детерминированы, только над явными значениями; нет «now»)
  date_parse_iso: { minArgs: 1, maxArgs: 1, category: "date" },
  date_to_iso: { minArgs: 1, maxArgs: 1, category: "date" },
  date_add_days: { minArgs: 2, maxArgs: 2, category: "date" },
  date_diff_days: { minArgs: 2, maxArgs: 2, category: "date" },
});

/**
 * Полный whitelist допустимых значений `op` (структурные + функциональные).
 * Любая операция вне этого списка отвергается на этапе валидации схемы (§13.4).
 */
export const TRANSFORM_ALLOWED_OPERATIONS = Object.freeze([
  ...TRANSFORM_STRUCTURAL_OPERATIONS,
  ...Object.keys(TRANSFORM_FUNCTION_OPERATIONS),
]);

/**
 * Значения по умолчанию для ограничений ресурсов Transform Node (§13.4):
 * бюджет шагов для декларативного `expression`, лимиты AST/коллекций/результата
 * и runtime-бюджеты для sandbox-режима `code`.
 */
export interface TransformDefaultLimits {
  codeMemoryMb: number;
  codeTimeoutMs: number;
  maxArrayLength: number;
  maxAstDepth: number;
  maxAstNodes: number;
  maxCodeLength: number;
  maxResultBytes: number;
  maxSteps: number;
  maxStringLength: number;
}

export const TRANSFORM_DEFAULT_LIMITS: Readonly<TransformDefaultLimits> = Object.freeze({
  codeMemoryMb: 16,
  codeTimeoutMs: 200,
  maxSteps: 100000,
  maxAstNodes: 2000,
  maxAstDepth: 64,
  maxCodeLength: 65536,
  maxStringLength: 65536,
  maxArrayLength: 100000,
  maxResultBytes: 262144,
});
