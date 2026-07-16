import {
  FBP_NODE_TYPE_DEFINITIONS,
  WorkflowContractError,
  WORKFLOW_SCHEMA_VERSION,
  canConnectPorts,
  getNodePaletteForKind,
  isFbpNodeType,
  isWorkflowGraphShape,
  validateWorkflowGraphContract,
} from "@bridge/contracts/c5-workflow";
import type {
  FbpGraphKind,
  FbpNodeTypeDefinition,
  WorkflowConnection,
  WorkflowNode,
  WorkflowSchema,
} from "@bridge/contracts/c5-workflow";

import type { WorkflowInstanceStatus, WorkflowNodeType, WorkflowStatus } from "../api/client/types";

/**
 * Редактор и контракт C5.
 *
 * Ревизия 2026-07-15 (решение A4, дефекты D2/D6/D8). Здесь жила ТРЕТЬЯ копия
 * валидации схемы — после Backend и движка. Она разошлась с ними ровно так, как
 * и должна была: `createWorkflowConnection` жёстко ставила `fromPort="out"` и
 * `toPort="in"`, потому что в 1.0 у всех узлов были ровно эти порты. В 2.0 порты
 * считает `getNodePortDefinitions` по узлу и графу, и редактор собирал связи,
 * которые сам же и отвергал (дефект D2).
 *
 * Теперь проверку целиком выполняет контракт. Здесь остаются только вещи уровня
 * UI: подписи статусов и фабрики узлов/связей с уникальными id.
 */

const WORKFLOW_NODE_TYPE_META = {} as Record<WorkflowNodeType, FbpNodeTypeDefinition>;
FBP_NODE_TYPE_DEFINITIONS.forEach((definition) => {
  WORKFLOW_NODE_TYPE_META[definition.type as WorkflowNodeType] = definition;
});

/**
 * Палитра узлов для вида графа. Раньше здесь был плоский список всех типов, и
 * редактор предлагал `start`/`end` внутри обычного Workflow — узлы, допустимые
 * только в субсхеме. Контракт знает это сам (`kinds` у определения типа).
 */
export function workflowNodePalette(kind: FbpGraphKind): readonly FbpNodeTypeDefinition[] {
  return getNodePaletteForKind(kind);
}

export function workflowNodeTypeLabel(type: WorkflowNodeType): string {
  return WORKFLOW_NODE_TYPE_META[type]?.label ?? type;
}

export function workflowNodeTypeDescription(type: WorkflowNodeType): string {
  return WORKFLOW_NODE_TYPE_META[type]?.description ?? "";
}

export function workflowNodePrimaryField(type: WorkflowNodeType) {
  return WORKFLOW_NODE_TYPE_META[type]?.primaryField ?? null;
}

/** Узел изменяет данные только если это вызов Backend API (ТЗ §13.5). */
export function workflowNodeMutatesData(type: WorkflowNodeType): boolean {
  return WORKFLOW_NODE_TYPE_META[type]?.mutatesData ?? false;
}

export function isSafeWorkflowNodeType(type: string): type is WorkflowNodeType {
  return isFbpNodeType(type);
}

/** Пустой граф нужного вида: `kind` обязателен с 2.0 и задаёт палитру и правила. */
export function createWorkflowSchema(kind: FbpGraphKind): WorkflowSchema {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind,
    nodes: [],
    connections: [],
  };
}

/**
 * Создаёт узел с уникальным id и авторасстановкой на холсте. Детерминированно
 * (без Math.random) — id вычисляется из уже существующих узлов.
 */
export function createWorkflowNode(
  type: WorkflowNodeType,
  existingNodes: WorkflowNode[],
  position?: WorkflowNode["position"],
): WorkflowNode {
  const id = nextUniqueId(`node-${type}`, existingNodes.map((node) => node.id));
  const index = existingNodes.length;
  const definition = WORKFLOW_NODE_TYPE_META[type];
  // Первичное поле заводится пустым: узел рождается недостроенным намеренно —
  // драфт валиден по форме графа (решение A10), а не по готовности.
  const config: Record<string, unknown> = definition?.primaryField
    ? { [definition.primaryField.key]: "" }
    : {};

  return {
    id,
    type,
    label: definition?.label ?? type,
    config,
    position: position ?? {
      x: 40 + (index % 3) * 220,
      y: 40 + Math.floor(index / 3) * 150,
    },
  };
}

/**
 * Создаёт связь. Порты ОБЯЗАТЕЛЬНЫ и приходят от холста — дефолтов `out`/`in`
 * здесь больше нет (дефект D2): в 2.0 их состав зависит от узла и графа, поэтому
 * угадать порт нельзя, а угаданный неверно отвергнет контракт.
 */
export function createWorkflowConnection(
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
  existingConnections: WorkflowConnection[],
): WorkflowConnection {
  return {
    id: nextUniqueId("conn", existingConnections.map((connection) => connection.id)),
    from,
    fromPort,
    to,
    toPort,
  };
}

export function isWorkflowSchema(value: unknown): value is WorkflowSchema {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkflowSchema>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.connections);
}

/**
 * Проверка драфта ТОЛЬКО по форме графа (решение A10) — та же граница, что на
 * бэкенде (`validateWorkflowSchemaShape`). Драфт сохраняется недостроенным: у узла
 * может быть не выбрано событие, порт висит. Полная проверка контракта — при
 * promote. Держать мок строже бэкенда нельзя: именно расхождение мока с
 * реальностью годами скрывало дефекты D2/D3.
 */
export function isWorkflowGraphShapeValid(value: unknown): boolean {
  return isWorkflowGraphShape(value);
}

export interface WorkflowSchemaValidation {
  valid: boolean;
  errors: string[];
  /** Узлы, к которым относится ошибка: по ним холст подсвечивает проблему. */
  nodeIds: string[];
}

/**
 * Проверяет схему контрактом C5 — тем же кодом, что Backend и движок.
 *
 * Контракт бросает на ПЕРВОЙ ошибке, а не собирает список: он писался для
 * рантайма, где важно не пропустить невалидный граф, а не перечислить всё. Для
 * редактора этого достаточно — оператор чинит по одной.
 */
export function validateWorkflowSchema(schema: WorkflowSchema): WorkflowSchemaValidation {
  try {
    validateWorkflowGraphContract(schema);
    return { valid: true, errors: [], nodeIds: [] };
  } catch (error) {
    if (error instanceof WorkflowContractError) {
      const nodeId = error.details?.nodeId;
      return {
        valid: false,
        errors: [error.message],
        nodeIds: typeof nodeId === "string" ? [nodeId] : [],
      };
    }
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Схема не прошла проверку"],
      nodeIds: [],
    };
  }
}

/**
 * Можно ли соединить порты. Обёртка над контрактом: холст зовёт её и в
 * `isValidConnection` (подсветить недопустимую цель во время перетаскивания), и
 * в `onConnect` (объяснить отказ текстом).
 */
export function canConnectWorkflowPorts(
  schema: WorkflowSchema,
  attempt: { source: string | null; sourceHandle: string | null; target: string | null; targetHandle: string | null },
): { valid: boolean; reason?: string } {
  return canConnectPorts(schema, attempt);
}

export function workflowStatusLabel(status: WorkflowStatus): string {
  switch (status) {
    case "active":
      return "Активен";
    case "draft":
      return "Черновик";
    case "archived":
      return "В архиве";
  }
}

export function workflowStatusTone(status: WorkflowStatus): "neutral" | "success" | "warning" {
  switch (status) {
    case "active":
      return "success";
    case "draft":
      return "neutral";
    case "archived":
      return "warning";
  }
}

export function workflowInstanceStatusLabel(status: WorkflowInstanceStatus): string {
  switch (status) {
    case "created":
      return "Создан";
    case "started":
      return "Запущен";
    case "running":
      return "Выполняется";
    case "waiting":
      return "Ожидание";
    case "callback_recorded":
      return "Callback получен";
    case "completed":
      return "Завершён";
    case "failed":
      return "Ошибка";
    case "cancelled":
      return "Отменён";
    case "degraded":
      return "Деградация";
  }
}

export function workflowInstanceStatusTone(
  status: WorkflowInstanceStatus,
): "neutral" | "success" | "warning" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "degraded":
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

function nextUniqueId(prefix: string, existing: string[]): string {
  const taken = new Set(existing);
  let index = existing.length + 1;
  let candidate = `${prefix}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}
