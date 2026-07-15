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
  FBP_BRANCH_OPERATORS,
  FBP_GRAPH_KINDS,
  FBP_NODE_TYPE_DEFINITIONS,
  FBP_NODE_TYPES,
  FBP_PORT_TYPES,
  PORT_COLORS,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowContractError,
  arePortTypesCompatible,
  assertWorkflowGraphShape,
  boundaryEndPorts,
  boundaryPortRows,
  boundaryStartPorts,
  branchOperatorNeedsRight,
  canConnectPorts,
  configPortRows,
  execInputPortIds,
  execOutputPortIds,
  formatWorkflowContractError,
  getFbpNodePortDefinition,
  getFbpNodeTypeDefinition,
  getNodeInputPortType,
  getNodeOutputPortType,
  getNodePaletteForKind,
  getNodePortDefinitions,
  isBoundaryPortType,
  isBranchOperator,
  isDataOnlyNodeType,
  isExecPortId,
  isExecSideEffectNode,
  isFbpGraphKind,
  isFbpNodeType,
  isMergeExecInputId,
  isNodeTypeAllowedInKind,
  isPortType,
  isWorkflowGraphShape,
  nodeBoundaryPorts,
  portColor,
  subSchemaNodePorts,
  validateWorkflowGraphContract,
} from "./c5-workflow.js";
export type {
  ConnectAttempt,
  ConnectCheckResult,
  FbpBoundaryPort,
  FbpBranchOperator,
  FbpConfigPortRow,
  FbpGraphKind,
  FbpNodePortDefinition,
  FbpNodePrimaryFieldDefinition,
  FbpNodeType,
  FbpNodeTypeDefinition,
  FbpPortDirection,
  FbpPortType,
  ValidateWorkflowGraphOptions,
  WorkflowConnection,
  WorkflowNode,
  WorkflowSchema,
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
 * Ревизия 2026-07-15: декларативная «проводка» входов (FBP_INPUT_SOURCE_KINDS со
 * значениями params/node/const) удалена — её роль полностью взяли на себя порты и
 * связи графа. Изоляция §13.4 сохранена: узел по-прежнему видит ТОЛЬКО собранный
 * `input`, но собирается он теперь по входящим data-связям, а не по конфигу.
 */

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
 * Ревизия 2026-07-15: TRANSFORM_DEFAULT_LIMITS переехали в `c5-workflow.ts` и
 * реэкспортируются отсюда для совместимости. Причина: `c5.ts` тянет `node:fs` и
 * `c4.ts`, поэтому не импортируется ни браузером, ни CommonJS-сборкой Backend, —
 * а лимиты нужны обеим сторонам. `c5-workflow.ts` не имеет импортов вовсе.
 */
export { TRANSFORM_DEFAULT_LIMITS } from "./c5-workflow.js";
export type { TransformDefaultLimits } from "./c5-workflow.js";
