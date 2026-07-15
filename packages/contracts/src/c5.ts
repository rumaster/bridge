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

// FBP_BACKEND_API_METHODS переехали в `c5-workflow.ts` (нужны движку, который не
// может грузить `c5.ts` с его node:fs) и реэкспортируются отсюда.
export { FBP_BACKEND_API_METHODS } from "./c5-workflow.js";

/**
 * Ревизия 2026-07-15: декларативная «проводка» входов (FBP_INPUT_SOURCE_KINDS со
 * значениями params/node/const) удалена — её роль полностью взяли на себя порты и
 * связи графа. Изоляция §13.4 сохранена: узел по-прежнему видит ТОЛЬКО собранный
 * `input`, но собирается он теперь по входящим data-связям, а не по конфигу.
 */

/**
 * Ревизия 2026-07-15: whitelist операций Transform Node (TRANSFORM_STRUCTURAL_OPERATIONS,
 * TRANSFORM_FUNCTION_OPERATIONS, TRANSFORM_ALLOWED_OPERATIONS) удалён вместе с режимом
 * expression. У узла transform остался только JS-текст (решение A8), а роль «проводки»,
 * ради которой выражения применялись в остальных узлах (backend-api.body/query,
 * branch.condition, llm.prompt, wait-event.correlation), взяли на себя порты и связи
 * графа. Изоляция §13.4 держится на песочнице transform/code-sandbox.ts: фильтр
 * запрещённых токенов, отдельный процесс с node:vm без Node-глобалей, жёсткие
 * таймаут и лимит памяти.
 */

export { TRANSFORM_DEFAULT_LIMITS } from "./c5-workflow.js";
export type { TransformDefaultLimits } from "./c5-workflow.js";
