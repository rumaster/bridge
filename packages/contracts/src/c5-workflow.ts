/** Версия схемы Workflow (форма графа Node/Connection). */
export const WORKFLOW_SCHEMA_VERSION = "1.0.0";

/** Тип данных/управления, который проходит через порт узла Workflow. */
export const FBP_PORT_TYPES = Object.freeze([
  "exec",
  "string",
  "number",
  "boolean",
  "object",
  "string_array",
  "object_array",
  "any",
] as const);

export type FbpPortType = (typeof FBP_PORT_TYPES)[number];
export type FbpPortDirection = "input" | "output";

export interface FbpNodePortDefinition {
  readonly id: string;
  readonly label: string;
  readonly type: FbpPortType;
  readonly direction: FbpPortDirection;
}

export interface FbpNodePrimaryFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
}

export interface FbpNodeTypeDefinition {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly primaryField: FbpNodePrimaryFieldDefinition;
  readonly mutatesData: boolean;
  readonly ports: readonly FbpNodePortDefinition[];
}

const EXEC_INPUT_PORT = Object.freeze({
  id: "in",
  label: "Вход",
  type: "exec",
  direction: "input",
} satisfies FbpNodePortDefinition);

const EXEC_OUTPUT_PORT = Object.freeze({
  id: "out",
  label: "Выход",
  type: "exec",
  direction: "output",
} satisfies FbpNodePortDefinition);

/**
 * Предметно-нейтральный набор узлов коммуникационной платформы (ТЗ §13.13-п.1).
 * Ядро исполнения нейтрально; доменные узлы исходного fbp-engine удалены.
 */
export const FBP_NODE_TYPE_DEFINITIONS = Object.freeze([
  {
    type: "backend-api",
    label: "Вызов Backend API",
    description: "Единственный узел, изменяющий данные через публичный Backend API.",
    primaryField: { key: "path", label: "Backend API path", placeholder: "/api/v1/tickets" },
    mutatesData: true,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
  {
    type: "llm",
    label: "Вызов LLM",
    description: "Запрашивает ответ у языковой модели через Backend/AI-фасад.",
    primaryField: { key: "prompt", label: "Промпт для LLM", placeholder: "Сформулируй ответ клиенту" },
    mutatesData: false,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
  {
    type: "knowledge-base-search",
    label: "Поиск в Knowledge Base",
    description: "Ищет релевантные фрагменты в базе знаний организации.",
    primaryField: { key: "query", label: "Поисковый запрос", placeholder: "{{message.text}}" },
    mutatesData: false,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
  {
    type: "branch",
    label: "Ветвление",
    description: "Выбирает следующий узел по булевому условию.",
    primaryField: { key: "condition", label: "Условие ветвления", placeholder: "{{kb.found}} == true" },
    mutatesData: false,
    ports: [
      EXEC_INPUT_PORT,
      { id: "true", label: "Да", type: "exec", direction: "output" },
      { id: "false", label: "Нет", type: "exec", direction: "output" },
    ],
  },
  {
    type: "transform",
    label: "Transform Node",
    description: "Преобразует данные безопасным декларативным выражением.",
    primaryField: { key: "expression", label: "Выражение трансформации", placeholder: "payload.text.trim()" },
    mutatesData: false,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
  {
    type: "sub_schema",
    label: "Субсхема",
    description: "Запускает переиспользуемую Workflow-субсхему по ссылке на slug.",
    primaryField: { key: "subSchemaSlug", label: "Субсхема", placeholder: "support-common-context" },
    mutatesData: false,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
  {
    type: "wait-event",
    label: "Ожидание события",
    description: "Приостанавливает исполнение до наступления внешнего события.",
    primaryField: { key: "event_type", label: "Ожидаемое событие", placeholder: "channel.message_received" },
    mutatesData: false,
    ports: [EXEC_INPUT_PORT, EXEC_OUTPUT_PORT],
  },
] as const satisfies readonly FbpNodeTypeDefinition[]);

export const FBP_NODE_TYPES = Object.freeze(
  FBP_NODE_TYPE_DEFINITIONS.map((definition) => definition.type),
);

export type FbpNodeType = (typeof FBP_NODE_TYPES)[number];

const FBP_NODE_TYPE_BY_TYPE: ReadonlyMap<string, FbpNodeTypeDefinition> = new Map<string, FbpNodeTypeDefinition>(
  FBP_NODE_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export function getFbpNodeTypeDefinition(type: string): FbpNodeTypeDefinition | null {
  return FBP_NODE_TYPE_BY_TYPE.get(type) ?? null;
}

export function getFbpNodePortDefinition(
  nodeType: string,
  direction: FbpPortDirection,
  portId: string,
): FbpNodePortDefinition | null {
  const definition = getFbpNodeTypeDefinition(nodeType);
  return definition?.ports.find((port) => port.direction === direction && port.id === portId) ?? null;
}

export function arePortTypesCompatible(from: FbpPortType, to: FbpPortType): boolean {
  if (from === "exec" || to === "exec") {
    return from === "exec" && to === "exec";
  }
  return from === "any" || to === "any" || from === to;
}
