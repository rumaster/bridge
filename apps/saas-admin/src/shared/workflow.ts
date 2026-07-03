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
export const SAFE_WORKFLOW_NODE_TYPES: WorkflowNodeType[] = [
  "wait_event",
  "kb_search",
  "llm_call",
  "branch",
  "transform",
  "backend_api_call"
];

interface WorkflowNodeTypeMeta {
  label: string;
  description: string;
  /** Основное поле конфигурации, редактируемое в панели свойств. */
  primaryField: { key: string; label: string; placeholder: string };
  /** Может ли узел изменять данные (только вызов Backend API — ТЗ §13.5). */
  mutatesData: boolean;
}

const WORKFLOW_NODE_TYPE_META: Record<WorkflowNodeType, WorkflowNodeTypeMeta> = {
  wait_event: {
    label: "Ожидание события",
    description: "Приостанавливает исполнение до наступления внешнего события.",
    primaryField: { key: "event", label: "Ожидаемое событие", placeholder: "channel.message_received" },
    mutatesData: false
  },
  kb_search: {
    label: "Поиск в Knowledge Base",
    description: "Ищет релевантные фрагменты в базе знаний организации.",
    primaryField: { key: "query", label: "Поисковый запрос", placeholder: "{{message.text}}" },
    mutatesData: false
  },
  llm_call: {
    label: "Вызов LLM",
    description: "Запрашивает ответ у языковой модели через SVC-AI.",
    primaryField: { key: "prompt", label: "Промпт для LLM", placeholder: "Сформулируй ответ клиенту" },
    mutatesData: false
  },
  branch: {
    label: "Ветвление",
    description: "Выбирает следующий узел по условию.",
    primaryField: { key: "condition", label: "Условие ветвления", placeholder: "{{kb.found}} == true" },
    mutatesData: false
  },
  transform: {
    label: "Transform Node",
    description: "Преобразует данные в изолированной песочнице (без доступа к БД).",
    primaryField: { key: "expression", label: "Выражение трансформации", placeholder: "payload.text.trim()" },
    mutatesData: false
  },
  backend_api_call: {
    label: "Вызов Backend API",
    description: "Единственный узел, изменяющий данные — только через Backend API (ТЗ §13.5).",
    primaryField: { key: "endpoint", label: "Backend API endpoint", placeholder: "POST /api/v1/tickets" },
    mutatesData: true
  }
};

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
export function createWorkflowNode(type: WorkflowNodeType, existingNodes: WorkflowNode[]): WorkflowNode {
  const id = nextUniqueId(`node-${type}`, existingNodes.map((node) => node.id));
  const index = existingNodes.length;
  const primary = WORKFLOW_NODE_TYPE_META[type].primaryField;

  return {
    id,
    type,
    label: WORKFLOW_NODE_TYPE_META[type].label,
    config: { [primary.key]: "" },
    position: {
      x: 40 + (index % 3) * 220,
      y: 40 + Math.floor(index / 3) * 150
    }
  };
}

export function createWorkflowConnection(
  from: string,
  to: string,
  existingConnections: WorkflowConnection[]
): WorkflowConnection {
  return {
    id: nextUniqueId("conn", existingConnections.map((connection) => connection.id)),
    from,
    to
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
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const connection of connections) {
    if (connection.from === connection.to) {
      errors.push("Узел не может ссылаться сам на себя.");
    }

    if (!nodeIds.has(connection.from) || !nodeIds.has(connection.to)) {
      errors.push("Связь ссылается на несуществующий узел.");
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
