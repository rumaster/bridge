import {
  FBP_NODE_TYPE_DEFINITIONS,
  FBP_NODE_TYPES,
  WORKFLOW_SCHEMA_VERSION,
  arePortTypesCompatible,
  getFbpNodePortDefinition
} from "@bridge/contracts/c5-workflow";
import type {
  FbpNodeTypeDefinition,
  WorkflowNode as ContractWorkflowNode,
  WorkflowSchema as ContractWorkflowSchema
} from "@bridge/contracts/c5-workflow";

import type {
  WorkflowConnection,
  WorkflowInstanceStatus,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowSchema,
  WorkflowStatus
} from "../api/client/types";

/**
 * Безопасный набор узлов FBP (ТЗ §13.13). Визуальный редактор ограничивает
 * палитру только этими типами. Изменение данных допустимо исключительно через
 * узел вызова Backend API (ТЗ §13.5) — остальные узлы не мутируют состояние.
 * Это UX-ограничение: авторитетную проверку безопасности выполняет Backend/FBP.
 */
export const SAFE_WORKFLOW_NODE_TYPES: WorkflowNodeType[] = [...FBP_NODE_TYPES];

export const WORKFLOW_BODY_GRAPH_CONFIG_KEY = "bodyGraph";

const WORKFLOW_NODE_TYPE_META = {} as Record<WorkflowNodeType, FbpNodeTypeDefinition>;
FBP_NODE_TYPE_DEFINITIONS.forEach((definition) => {
  WORKFLOW_NODE_TYPE_META[definition.type as WorkflowNodeType] = definition;
});

export function workflowNodeTypeLabel(type: WorkflowNodeType): string {
  return WORKFLOW_NODE_TYPE_META[type].label;
}

export function workflowNodeTypeDescription(type: WorkflowNodeType): string {
  return WORKFLOW_NODE_TYPE_META[type].description;
}

export function workflowNodePrimaryField(type: WorkflowNodeType) {
  return WORKFLOW_NODE_TYPE_META[type].primaryField;
}

/** Узел изменяет данные только если это вызов Backend API (ТЗ §13.5). */
export function workflowNodeMutatesData(type: WorkflowNodeType): boolean {
  return WORKFLOW_NODE_TYPE_META[type].mutatesData;
}

export function isSafeWorkflowNodeType(type: string): type is WorkflowNodeType {
  return SAFE_WORKFLOW_NODE_TYPES.includes(type as WorkflowNodeType);
}

/**
 * Создаёт узел безопасного типа с уникальным id и авторасстановкой на холсте.
 * Детерминированно (без Math.random) — id вычисляется из уже существующих узлов.
 */
export function createWorkflowNode(
  type: WorkflowNodeType,
  existingNodes: WorkflowNode[],
  position?: WorkflowNode["position"]
): WorkflowNode {
  const id = nextUniqueId(`node-${type}`, existingNodes.map((node) => node.id));
  const index = existingNodes.length;
  const primary = WORKFLOW_NODE_TYPE_META[type].primaryField;
  const config: Record<string, unknown> = { [primary.key]: "" };

  return {
    id,
    type,
    label: WORKFLOW_NODE_TYPE_META[type].label,
    config,
    position: position ?? {
      x: 40 + (index % 3) * 220,
      y: 40 + Math.floor(index / 3) * 150
    }
  };
}

export function createWorkflowBodyGraph(ownerNodeId: string): WorkflowSchema {
  const entryNodeId = `${ownerNodeId}-body-transform`;
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    entry: entryNodeId,
    nodes: [
      {
        id: entryNodeId,
        type: "transform",
        label: "Подготовить контекст",
        config: { expression: "payload" },
        position: { x: 40, y: 40 }
      }
    ],
    connections: []
  };
}

export function workflowNodeSupportsBodyGraph(type: WorkflowNodeType): boolean {
  return type === "branch" || type === "transform";
}

export function isWorkflowSchema(value: unknown): value is WorkflowSchema {
  if (!isRecord(value)) {
    return false;
  }

  return Array.isArray(value.nodes) && Array.isArray(value.connections);
}

export function createWorkflowConnection(
  from: string,
  to: string,
  existingConnections: WorkflowConnection[],
  fromPort = "out",
  toPort = "in"
): WorkflowConnection {
  return {
    id: nextUniqueId("conn", existingConnections.map((connection) => connection.id)),
    from,
    fromPort,
    to,
    toPort
  };
}

export interface WorkflowSchemaValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Проверяет схему перед сохранением новой версии (ТЗ §13.10). UI-валидация —
 * подсказка редактору; окончательную проверку безопасности выполняет FBP.
 */
export function validateWorkflowSchema(schema: WorkflowSchema): WorkflowSchemaValidation {
  const errors: string[] = [];
  const nodes = schema.nodes ?? [];
  const connections = schema.connections ?? [];

  if (nodes.length === 0) {
    errors.push("Схема должна содержать хотя бы один узел.");
  }

  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      errors.push("Обнаружены дублирующиеся идентификаторы узлов.");
    }
    seenIds.add(node.id);

    if (!isSafeWorkflowNodeType(node.type)) {
      errors.push(`Узел «${node.label || node.id}» имеет запрещённый тип и не входит в безопасный набор.`);
    }

    if (!node.label.trim()) {
      errors.push(`У узла «${node.id}» должна быть заполнена метка.`);
    }

    if (node.type === "sub_schema") {
      const slug = node.config.subSchemaSlug;
      if (typeof slug !== "string" || slug.trim() === "") {
        errors.push(`Узел «${node.label || node.id}» должен ссылаться на субсхему.`);
      }
      if (node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY] !== undefined) {
        errors.push(`Узел «${node.label || node.id}» хранит только ссылку на субсхему без bodyGraph.`);
      }
    }

    const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
    if (bodyGraph !== undefined) {
      if (!isWorkflowSchema(bodyGraph)) {
        errors.push(`bodyGraph узла «${node.label || node.id}» должен быть схемой Workflow.`);
      } else {
        const bodyGraphValidation = validateWorkflowSchema(bodyGraph);
        for (const error of bodyGraphValidation.errors) {
          errors.push(`bodyGraph узла «${node.label || node.id}»: ${error}`);
        }
      }
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const connection of connections) {
    if (connection.from === connection.to) {
      errors.push("Узел не может ссылаться сам на себя.");
    }

    if (!nodeIds.has(connection.from) || !nodeIds.has(connection.to)) {
      errors.push("Связь ссылается на несуществующий узел.");
      continue;
    }

    if (!connection.fromPort?.trim() || !connection.toPort?.trim()) {
      errors.push("Связь должна указывать fromPort и toPort.");
      continue;
    }

    const fromNode = nodesById.get(connection.from);
    const toNode = nodesById.get(connection.to);
    // Порты считает контракт: с 2.0.0 они зависят от узла и графа (config
    // transform, границы субсхемы, динамические входы merge), а не от типа узла.
    const graph = schema as unknown as ContractWorkflowSchema;
    const fromPort = fromNode
      ? getFbpNodePortDefinition(fromNode as unknown as ContractWorkflowNode, "output", connection.fromPort, graph)
      : null;
    const toPort = toNode
      ? getFbpNodePortDefinition(toNode as unknown as ContractWorkflowNode, "input", connection.toPort, graph)
      : null;

    if (!fromPort || !toPort) {
      errors.push("Связь ссылается на несуществующий порт.");
      continue;
    }

    if (!arePortTypesCompatible(fromPort.type, toPort.type)) {
      errors.push("Типы портов связи несовместимы.");
    }
  }

  if (nodes.length > 1 && connections.length === 0) {
    errors.push("Соедините узлы хотя бы одной связью.");
  }

  return { valid: errors.length === 0, errors: dedupe(errors) };
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
  status: WorkflowInstanceStatus
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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
