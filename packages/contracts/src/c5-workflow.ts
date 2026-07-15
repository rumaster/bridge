/**
 * Контракт графа Workflow — единственный источник правды о портах и валидности
 * схемы. Импортируется и редактором (`apps/saas-admin`), и валидатором Backend, и
 * движком (`services/fbp-engine`): порты везде считает `getNodePortDefinitions`,
 * поэтому редактор не может нарисовать порт, которого не будет в рантайме.
 *
 * Модель исполнения — гибрид push/pull (Ревизия 2026-07-15, решение A1):
 *  - exec-поток задаёт порядок исполнения;
 *  - узлы-функции (`transform`, `variable_read`) exec-портов не имеют и
 *    вычисляются лениво, когда их выход кому-то понадобился;
 *  - `variable_write` — побочный эффект, поэтому exec-порты получает.
 */

/** Версия схемы Workflow (форма графа Node/Connection). */
export const WORKFLOW_SCHEMA_VERSION = "2.0.0";

/**
 * Ограничения ресурсов Transform Node (§13.4) — бюджеты JS-песочницы. Живут
 * здесь, а не в `c5.ts`, потому что `c5.ts` импортирует `node:fs` и `c4.ts`: его
 * не может загрузить ни браузер, ни CommonJS-сборка Backend, а лимиты нужны
 * обеим сторонам.
 *
 * Ревизия 2026-07-15: лимиты AST-вычислителя (`maxSteps`, `maxAstNodes`,
 * `maxAstDepth`, `maxStringLength`, `maxArrayLength`) убраны вместе с режимом
 * `expression` — считать стало нечего.
 */
export interface TransformDefaultLimits {
  codeMemoryMb: number;
  codeTimeoutMs: number;
  maxCodeLength: number;
  maxResultBytes: number;
}

export const TRANSFORM_DEFAULT_LIMITS: Readonly<TransformDefaultLimits> = Object.freeze({
  codeMemoryMb: 16,
  codeTimeoutMs: 200,
  maxCodeLength: 65536,
  maxResultBytes: 262144,
});

/** HTTP-методы, доступные узлу Backend API (совпадают с DTO C5). */
export const FBP_BACKEND_API_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const);

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

/**
 * Вид графа. `workflow` запускается событиями и не имеет start/end;
 * `subschema` вызывается узлом `sub_schema`, событий не содержит, но обязана
 * иметь ровно один start и один end.
 */
export const FBP_GRAPH_KINDS = Object.freeze(["workflow", "subschema"] as const);
export type FbpGraphKind = (typeof FBP_GRAPH_KINDS)[number];

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
  /** Виды графа, в которых узел доступен в палитре. */
  readonly kinds: readonly FbpGraphKind[];
}

export interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowConnection {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface WorkflowSchema {
  schema_version: string;
  kind: FbpGraphKind;
  slug?: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  variables?: Record<string, unknown>;
}

/** Строка настраиваемого порта в `config.inputs` / `config.outputs`. */
export interface FbpConfigPortRow {
  readonly name: string;
  readonly type: FbpPortType;
  /** Только для выходов transform: путь от `{ result }`. */
  readonly path?: string;
}

// ---------------------------------------------------------------------------
// Операторы ветвления
// ---------------------------------------------------------------------------

export const FBP_BRANCH_OPERATORS = Object.freeze([
  { value: "truthy", label: "истина" },
  { value: "exists", label: "существует" },
  { value: "equals", label: "=" },
  { value: "not_equals", label: "!=" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
] as const);

export type FbpBranchOperator = (typeof FBP_BRANCH_OPERATORS)[number]["value"];

const FBP_BRANCH_OPERATOR_VALUES: readonly string[] = FBP_BRANCH_OPERATORS.map((item) => item.value);

export function isBranchOperator(value: unknown): value is FbpBranchOperator {
  return typeof value === "string" && FBP_BRANCH_OPERATOR_VALUES.includes(value);
}

/** Операторы, которым нужен правый операнд. `truthy`/`exists` — унарные. */
export function branchOperatorNeedsRight(operator: FbpBranchOperator): boolean {
  return operator !== "truthy" && operator !== "exists";
}

// ---------------------------------------------------------------------------
// Каталог узлов
// ---------------------------------------------------------------------------

const ALL_KINDS: readonly FbpGraphKind[] = ["workflow", "subschema"];

/**
 * Предметно-нейтральный набор узлов коммуникационной платформы (ТЗ §13.13-п.1).
 * Ядро исполнения нейтрально; доменные узлы исходного fbp-engine удалены.
 */
export const FBP_NODE_TYPE_DEFINITIONS = Object.freeze([
  {
    type: "wait-event",
    label: "Ожидание события",
    description: "Источник исполнения: схема запускается при наступлении события.",
    primaryField: { key: "event_type", label: "Ожидаемое событие", placeholder: "message.created" },
    mutatesData: false,
    kinds: ["workflow"],
  },
  {
    type: "backend-api",
    label: "Вызов Backend API",
    description: "Единственный узел, изменяющий данные через публичный Backend API.",
    primaryField: { key: "operation_id", label: "Вызов", placeholder: "createConversation" },
    mutatesData: true,
    kinds: ALL_KINDS,
  },
  {
    type: "llm",
    label: "Вызов LLM",
    description: "Запрашивает ответ у языковой модели через Backend/AI-фасад.",
    primaryField: { key: "prompt", label: "Промпт для LLM", placeholder: "Сформулируй ответ клиенту" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "knowledge-base-search",
    label: "Поиск в Knowledge Base",
    description: "Ищет документы базы знаний организации по ключевым фразам и тегам.",
    primaryField: { key: "top_k", label: "Сколько документов вернуть", placeholder: "5" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "branch",
    label: "Ветвление",
    description: "Сравнивает value с right и направляет исполнение в true или false.",
    primaryField: { key: "operator", label: "Оператор", placeholder: "истина" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "transform",
    label: "Transform",
    description: "Произвольный JS: получает input, возвращает значение через return.",
    primaryField: { key: "code", label: "JS-код", placeholder: "return input.value;" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "variable_read",
    label: "Чтение переменной",
    description: "Читает переменные инстанса. Вычисляется по требованию.",
    primaryField: { key: "outputs", label: "Переменные", placeholder: "value" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "variable_write",
    label: "Запись переменной",
    description: "Записывает переменные инстанса. Исполняется в exec-потоке.",
    primaryField: { key: "inputs", label: "Переменные", placeholder: "value" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "merge",
    label: "Слияние потоков",
    description: "Ждёт прихода всех подключённых exec-потоков и продолжает один раз.",
    primaryField: { key: "label", label: "Подпись", placeholder: "Слияние" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "sub_schema",
    label: "Субсхема",
    description: "Запускает переиспользуемую субсхему по ссылке на slug.",
    primaryField: { key: "subSchemaSlug", label: "Субсхема", placeholder: "support-common-context" },
    mutatesData: false,
    kinds: ALL_KINDS,
  },
  {
    type: "start",
    label: "Начало субсхемы",
    description: "Граница субсхемы: выходы задают, что субсхема принимает на вход.",
    primaryField: { key: "outputs", label: "Входные порты субсхемы", placeholder: "query" },
    mutatesData: false,
    kinds: ["subschema"],
  },
  {
    type: "end",
    label: "Конец субсхемы",
    description: "Граница субсхемы: входы задают, что субсхема отдаёт наружу.",
    primaryField: { key: "inputs", label: "Выходные порты субсхемы", placeholder: "result" },
    mutatesData: false,
    kinds: ["subschema"],
  },
] as const satisfies readonly FbpNodeTypeDefinition[]);

export const FBP_NODE_TYPES = Object.freeze(
  FBP_NODE_TYPE_DEFINITIONS.map((definition) => definition.type),
);

export type FbpNodeType = (typeof FBP_NODE_TYPE_DEFINITIONS)[number]["type"];

const FBP_NODE_TYPE_BY_TYPE: ReadonlyMap<string, FbpNodeTypeDefinition> = new Map<string, FbpNodeTypeDefinition>(
  FBP_NODE_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export function getFbpNodeTypeDefinition(type: string): FbpNodeTypeDefinition | null {
  return FBP_NODE_TYPE_BY_TYPE.get(type) ?? null;
}

export function isFbpNodeType(value: unknown): value is FbpNodeType {
  return typeof value === "string" && FBP_NODE_TYPE_BY_TYPE.has(value);
}

export function isFbpGraphKind(value: unknown): value is FbpGraphKind {
  return value === "workflow" || value === "subschema";
}

function definitionSupportsKind(definition: FbpNodeTypeDefinition, kind: FbpGraphKind): boolean {
  // `as const` сужает kinds до литерального кортежа, поэтому includes() без
  // расширения типа получает параметр never.
  return (definition.kinds as readonly string[]).includes(kind);
}

export function isNodeTypeAllowedInKind(kind: FbpGraphKind, nodeType: string): boolean {
  const definition = getFbpNodeTypeDefinition(nodeType);
  return definition ? definitionSupportsKind(definition, kind) : false;
}

export function getNodePaletteForKind(kind: FbpGraphKind): readonly FbpNodeTypeDefinition[] {
  return FBP_NODE_TYPE_DEFINITIONS.filter((definition) => definitionSupportsKind(definition, kind));
}

// ---------------------------------------------------------------------------
// Порты: exec и data
// ---------------------------------------------------------------------------

/**
 * Data-only узлы — pure-функции: exec-портов не имеют, вычисляются по требованию.
 * `variable_write` присутствует здесь как «работа с данными», но exec-порты
 * получает через `isExecSideEffectNode` — это побочный эффект, а не чистое чтение.
 */
const DATA_ONLY_NODE_TYPES: readonly string[] = Object.freeze([
  "transform",
  "variable_read",
  "variable_write",
]);

const EXEC_PORT_IDS: readonly string[] = Object.freeze(["in", "out", "true", "false"]);

/**
 * Узел merge синхронизирует несколько потоков: один exec-выход и динамический
 * набор входов in_1, in_2, … На новом узле два входа; при подключении к
 * последнему свободному добавляется ещё один — всегда остаётся ровно один
 * свободный вход.
 */
const MERGE_MIN_EXEC_INPUTS = 2;
const MERGE_EXEC_INPUT_PATTERN = /^in_([1-9][0-9]*)$/;

export function isMergeExecInputId(portId: unknown): boolean {
  return typeof portId === "string" && MERGE_EXEC_INPUT_PATTERN.test(portId);
}

function mergeExecInputIndex(portId: unknown): number {
  const match = typeof portId === "string" ? portId.match(MERGE_EXEC_INPUT_PATTERN) : null;
  return match ? Number(match[1]) : 0;
}

export function isExecPortId(portId: unknown): boolean {
  return (typeof portId === "string" && EXEC_PORT_IDS.includes(portId)) || isMergeExecInputId(portId);
}

function mergeExecInputPortIds(node: WorkflowNode | null, graph?: WorkflowSchema | null): string[] {
  let maxConnected = 0;
  if (node && graph && Array.isArray(graph.connections)) {
    for (const connection of graph.connections) {
      if (connection.to !== node.id) continue;
      const index = mergeExecInputIndex(connection.toPort);
      if (index > maxConnected) maxConnected = index;
    }
  }
  const count = Math.max(MERGE_MIN_EXEC_INPUTS, maxConnected + 1);
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) ids.push(`in_${index}`);
  return ids;
}

export function isDataOnlyNodeType(type: string): boolean {
  return DATA_ONLY_NODE_TYPES.includes(type);
}

/**
 * `variable_write` — побочный эффект без выходов данных: исполняется в
 * exec-потоке, поэтому exec-порты получает, несмотря на присутствие в
 * DATA_ONLY_NODE_TYPES.
 */
export function isExecSideEffectNode(nodeOrType: WorkflowNode | string): boolean {
  const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType.type;
  return type === "variable_write";
}

export function execInputPortIds(nodeOrType: WorkflowNode | string, graph?: WorkflowSchema | null): string[] {
  const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType.type;
  if (isExecSideEffectNode(nodeOrType)) return ["in"];
  // wait-event — источник exec: входа управления у него нет (решение A1).
  if (type === "wait-event" || type === "start" || isDataOnlyNodeType(type)) return [];
  if (type === "merge") {
    return typeof nodeOrType === "string"
      ? mergeExecInputPortIds(null, null)
      : mergeExecInputPortIds(nodeOrType, graph);
  }
  return ["in"];
}

export function execOutputPortIds(nodeOrType: WorkflowNode | string): string[] {
  const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType.type;
  if (isExecSideEffectNode(nodeOrType)) return ["out"];
  if (type === "end" || isDataOnlyNodeType(type)) return [];
  if (type === "branch") return ["true", "false"];
  return ["out"];
}

// ---------------------------------------------------------------------------
// Настраиваемые порты из config
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPortType(value: unknown): value is FbpPortType {
  return typeof value === "string" && (FBP_PORT_TYPES as readonly string[]).includes(value);
}

/**
 * Нормализует строки портов из config. Некорректные записи молча отбрасываются —
 * строгая проверка живёт в `validateWorkflowGraphContract`, чтобы редактор мог
 * рисовать частично заполненный конфиг, а сохранение в рабочую версию — падало.
 */
export function configPortRows(value: unknown): FbpConfigPortRow[] {
  if (!Array.isArray(value)) return [];
  const rows: FbpConfigPortRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) continue;
    const name = item.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const path = typeof item.path === "string" && item.path.trim() ? item.path.trim() : undefined;
    rows.push({ name, type: isPortType(item.type) ? item.type : "any", path });
  }
  return rows;
}

function configPortType(value: unknown, portId: string): FbpPortType {
  for (const row of configPortRows(value)) {
    if (row.name === portId) return row.type;
  }
  return "any";
}

/**
 * Порты variable_read / variable_write: имена переменных из config.outputs /
 * config.inputs. Пустая конфигурация даёт один порт `value`, чтобы узел не
 * оставался вовсе без портов и его можно было подключить.
 */
function variablePortRows(node: WorkflowNode, key: "inputs" | "outputs"): FbpConfigPortRow[] {
  const rows = configPortRows(isRecord(node.config) ? node.config[key] : undefined);
  return rows.length > 0 ? rows : [{ name: "value", type: "any" }];
}

// ---------------------------------------------------------------------------
// Границы субсхем
// ---------------------------------------------------------------------------

const BOUNDARY_PORT_ID_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

export interface FbpBoundaryPort {
  readonly id: string;
  readonly label: string;
  readonly type: FbpPortType;
}

/** Граничный порт субсхемы не может быть exec: start/end обмениваются только данными. */
export function isBoundaryPortType(value: unknown): value is Exclude<FbpPortType, "exec"> {
  return isPortType(value) && value !== "exec";
}

export function boundaryPortRows(value: unknown): FbpBoundaryPort[] {
  if (!Array.isArray(value)) return [];
  const rows: FbpBoundaryPort[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!BOUNDARY_PORT_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (!isBoundaryPortType(item.type)) continue;
    seen.add(id);
    const label = typeof item.label === "string" && item.label.trim() ? item.label : id;
    rows.push({ id, label, type: item.type });
  }
  return rows;
}

/**
 * Граничные порты узла start/end субсхемы: для start — config.outputs (что
 * субсхема получает на вход), для end — config.inputs (что отдаёт наружу).
 */
export function nodeBoundaryPorts(node: WorkflowNode | null | undefined, which: "start" | "end"): FbpBoundaryPort[] {
  if (!node || !isRecord(node.config)) return [];
  return boundaryPortRows(node.config[which === "start" ? "outputs" : "inputs"]);
}

export function boundaryStartPorts(graph: WorkflowSchema | null | undefined): FbpBoundaryPort[] {
  const start = graph?.nodes?.find((node) => node.type === "start");
  return nodeBoundaryPorts(start, "start");
}

export function boundaryEndPorts(graph: WorkflowSchema | null | undefined): FbpBoundaryPort[] {
  const end = graph?.nodes?.find((node) => node.type === "end");
  return nodeBoundaryPorts(end, "end");
}

/**
 * Порты узла sub_schema зеркалят границу вызываемой субсхемы: входы — её
 * start-порты, выходы — её end-порты. Источник — инлайн-граф `config.graph`,
 * иначе снимок `config.ports`, который редактор кэширует при выборе slug
 * (контракт сам slug не резолвит — он не ходит в БД).
 */
export function subSchemaNodePorts(node: WorkflowNode): {
  inputs: FbpBoundaryPort[];
  outputs: FbpBoundaryPort[];
} {
  const config = isRecord(node.config) ? node.config : {};
  const inlineGraph = config.graph;
  if (isRecord(inlineGraph) && Array.isArray(inlineGraph.nodes)) {
    const graph = inlineGraph as unknown as WorkflowSchema;
    return { inputs: boundaryStartPorts(graph), outputs: boundaryEndPorts(graph) };
  }
  const snapshot = isRecord(config.ports) ? config.ports : {};
  return {
    inputs: boundaryPortRows(snapshot.inputs),
    outputs: boundaryPortRows(snapshot.outputs),
  };
}

// ---------------------------------------------------------------------------
// Типы портов по узлу
// ---------------------------------------------------------------------------

export function getNodeOutputPortType(
  graph: WorkflowSchema | null | undefined,
  node: WorkflowNode,
  portId: string,
): FbpPortType {
  const config = isRecord(node.config) ? node.config : {};
  switch (node.type) {
    case "start": {
      const found = boundaryStartPorts(graph).find((item) => item.id === portId);
      return found ? found.type : "any";
    }
    case "sub_schema": {
      const found = subSchemaNodePorts(node).outputs.find((item) => item.id === portId);
      return found ? found.type : "any";
    }
    // wait-event отдаёт специфические данные события одним объектом (решение A6).
    case "wait-event":
      return portId === "data" ? "object" : "any";
    case "knowledge-base-search":
      return portId === "documents" ? "object_array" : "any";
    case "transform":
    case "llm":
    case "backend-api":
      return configPortType(config.outputs, portId);
    case "variable_read":
      return configPortType(variablePortRows(node, "outputs"), portId);
    default:
      return "any";
  }
}

export function getNodeInputPortType(
  graph: WorkflowSchema | null | undefined,
  node: WorkflowNode,
  portId: string,
): FbpPortType {
  const config = isRecord(node.config) ? node.config : {};
  switch (node.type) {
    case "end": {
      const found = boundaryEndPorts(graph).find((item) => item.id === portId);
      return found ? found.type : "any";
    }
    case "sub_schema": {
      const found = subSchemaNodePorts(node).inputs.find((item) => item.id === portId);
      return found ? found.type : "any";
    }
    case "knowledge-base-search":
      return portId === "keys" || portId === "tags" ? "string_array" : "any";
    // branch сравнивает value с right; оба принимают что угодно (решение по ТЗ).
    case "branch":
      return portId === "value" || portId === "right" ? "any" : "any";
    case "transform":
    case "llm":
    case "backend-api":
      return configPortType(config.inputs, portId);
    case "variable_write":
      return configPortType(variablePortRows(node, "inputs"), portId);
    default:
      return "any";
  }
}

// ---------------------------------------------------------------------------
// Полный набор портов узла
// ---------------------------------------------------------------------------

export function getNodePortDefinitions(
  node: WorkflowNode,
  graph?: WorkflowSchema | null,
): { inputs: FbpNodePortDefinition[]; outputs: FbpNodePortDefinition[] } {
  const inputs = new Map<string, FbpNodePortDefinition>();
  const outputs = new Map<string, FbpNodePortDefinition>();
  const addInput = (id: string, type: FbpPortType, label = id): void => {
    if (!inputs.has(id)) inputs.set(id, { id, label, type, direction: "input" });
  };
  const addOutput = (id: string, type: FbpPortType, label = id): void => {
    if (!outputs.has(id)) outputs.set(id, { id, label, type, direction: "output" });
  };

  for (const id of execInputPortIds(node, graph)) addInput(id, "exec", id);
  for (const id of execOutputPortIds(node)) addOutput(id, "exec", id);

  addBaseDataPorts(node, graph, addInput, addOutput);

  return { inputs: [...inputs.values()], outputs: [...outputs.values()] };
}

type AddPort = (id: string, type: FbpPortType, label?: string) => void;

function addBaseDataPorts(
  node: WorkflowNode,
  graph: WorkflowSchema | null | undefined,
  addInput: AddPort,
  addOutput: AddPort,
): void {
  const config = isRecord(node.config) ? node.config : {};
  switch (node.type) {
    case "start":
      for (const item of boundaryStartPorts(graph)) addOutput(item.id, item.type, item.label);
      break;
    case "end":
      for (const item of boundaryEndPorts(graph)) addInput(item.id, item.type, item.label);
      break;
    case "sub_schema": {
      const ports = subSchemaNodePorts(node);
      for (const item of ports.inputs) addInput(item.id, item.type, item.label);
      for (const item of ports.outputs) addOutput(item.id, item.type, item.label);
      break;
    }
    case "wait-event":
      addOutput("data", "object", "data");
      break;
    case "knowledge-base-search":
      addInput("keys", "string_array", "keys");
      addInput("tags", "string_array", "tags");
      addOutput("documents", "object_array", "documents");
      break;
    case "branch":
      addInput("value", "any", "value");
      addInput("right", "any", "right");
      break;
    case "transform":
    case "llm":
    case "backend-api":
      for (const row of configPortRows(config.inputs)) addInput(row.name, row.type, row.name);
      for (const row of configPortRows(config.outputs)) addOutput(row.name, row.type, row.name);
      break;
    case "variable_read":
      for (const row of variablePortRows(node, "outputs")) addOutput(row.name, row.type, row.name);
      break;
    case "variable_write":
      for (const row of variablePortRows(node, "inputs")) addInput(row.name, row.type, row.name);
      break;
    default:
      break;
  }
}

export function arePortTypesCompatible(from: FbpPortType, to: FbpPortType): boolean {
  if (from === "exec" || to === "exec") {
    return from === "exec" && to === "exec";
  }
  return from === "any" || to === "any" || from === to;
}

export function getFbpNodePortDefinition(
  node: WorkflowNode,
  direction: FbpPortDirection,
  portId: string,
  graph?: WorkflowSchema | null,
): FbpNodePortDefinition | null {
  const ports = getNodePortDefinitions(node, graph);
  const list = direction === "input" ? ports.inputs : ports.outputs;
  return list.find((port) => port.id === portId) ?? null;
}

// ---------------------------------------------------------------------------
// Цвета портов (общие для редактора)
// ---------------------------------------------------------------------------

export const PORT_COLORS: Readonly<Record<FbpPortType, string>> = Object.freeze({
  exec: "#ffffff",
  string: "#ff6fb1",
  number: "#31c48d",
  boolean: "#ef4444",
  object: "#3b82f6",
  string_array: "#f9a8d4",
  object_array: "#67e8f9",
  any: "#9ca3af",
});

export function portColor(type: FbpPortType): string {
  return PORT_COLORS[type] ?? PORT_COLORS.any;
}

// ---------------------------------------------------------------------------
// Ошибки валидации
// ---------------------------------------------------------------------------

type ErrorDetails = Record<string, unknown>;

const VALIDATION_ERROR_MESSAGES: Record<string, (details: ErrorDetails) => string> = {
  invalid_graph_shape: () => "Граф схемы имеет некорректную форму",
  invalid_graph_kind: ({ kind }) => `Недопустимый вид графа: ${String(kind)}`,
  unsupported_schema_version: ({ version }) =>
    `Неподдерживаемая версия схемы: ${String(version)} (нужна ${WORKFLOW_SCHEMA_VERSION})`,
  duplicate_node_id: ({ nodeId }) => `Дублирующий id узла: ${String(nodeId)}`,
  unknown_node_type: ({ nodeType }) => `Неизвестный тип узла: ${String(nodeType)}`,
  node_type_blocked: ({ nodeType, kind }) => `Узел «${String(nodeType)}» недоступен в графе вида «${String(kind)}»`,
  single_start: () => "Субсхема должна содержать ровно один start-узел",
  single_end: () => "Субсхема должна содержать ровно один end-узел",
  missing_event_source: () => "Схема должна содержать хотя бы один узел «Ожидание события»",
  unknown_connection_from: ({ connectionId, nodeId }) =>
    `Связь ${String(connectionId)} ссылается на неизвестный узел ${String(nodeId)}`,
  unknown_connection_to: ({ connectionId, nodeId }) =>
    `Связь ${String(connectionId)} ссылается на неизвестный узел ${String(nodeId)}`,
  mixed_port_kinds: ({ connectionId }) => `Связь ${String(connectionId)} смешивает exec-порт и data-порт`,
  missing_exec_output: ({ nodeId, portId }) => `У узла ${String(nodeId)} нет exec-выхода ${String(portId)}`,
  missing_exec_input: ({ nodeId, portId }) => `У узла ${String(nodeId)} нет exec-входа ${String(portId)}`,
  missing_data_output: ({ nodeId, portId }) => `У узла ${String(nodeId)} нет выхода ${String(portId)}`,
  missing_data_input: ({ nodeId, portId }) => `У узла ${String(nodeId)} нет входа ${String(portId)}`,
  incompatible_ports: ({ connectionId, fromNodeId, fromPortId, fromType, toNodeId, toPortId, toType }) =>
    `Несовместимые порты в связи ${String(connectionId)}: ${String(fromNodeId)}.${String(fromPortId)} (${String(fromType)}) → ${String(toNodeId)}.${String(toPortId)} (${String(toType)})`,
  duplicate_data_input: ({ nodeId, portId }) => `Вход ${String(nodeId)}.${String(portId)} уже подключён`,
  exec_cycle: ({ nodeId }) => `Exec-граф содержит цикл около узла ${String(nodeId)}`,
  invalid_config_ports_shape: ({ nodeId, key }) => `Узлу ${String(nodeId)} нужен массив config.${String(key)}`,
  invalid_config_port_name: ({ nodeId, key }) => `Узел ${String(nodeId)} содержит порт config.${String(key)} без имени`,
  invalid_config_port_type: ({ nodeId, portType }) =>
    `Узел ${String(nodeId)} содержит неизвестный тип порта ${String(portType)}`,
  duplicate_config_port: ({ nodeId, name }) => `Узел ${String(nodeId)} содержит повторяющийся порт ${String(name)}`,
  invalid_transform_code: ({ nodeId }) => `transform-узлу ${String(nodeId)} нужен непустой config.code`,
  invalid_branch_operator: ({ nodeId }) => `Узлу ветвления ${String(nodeId)} нужен корректный config.operator`,
  invalid_event_type: ({ nodeId }) => `Узлу ${String(nodeId)} нужен непустой config.event_type`,
  invalid_sub_schema_slug: ({ nodeId }) => `Узлу субсхемы ${String(nodeId)} нужен непустой config.subSchemaSlug`,
  invalid_boundary_port_id: ({ nodeId, portId }) =>
    `Граничный порт ${String(nodeId)}.${String(portId)} имеет недопустимый id (нужен ^[A-Za-z0-9_]{1,40}$)`,
  invalid_boundary_port_type: ({ nodeId, portType }) =>
    `Граничный порт узла ${String(nodeId)} имеет недопустимый тип ${String(portType)}`,
  duplicate_boundary_port: ({ nodeId, portId }) =>
    `Граничный порт ${String(nodeId)}.${String(portId)} объявлен повторно`,
  forbidden_config_key: ({ nodeId, key }) =>
    `Узел ${String(nodeId)} содержит запрещённый ключ config.${String(key)}`,
};

export function formatWorkflowContractError(code: string, details: ErrorDetails = {}): string {
  const format = VALIDATION_ERROR_MESSAGES[code];
  return format ? format(details) : `Некорректный граф схемы: ${code}`;
}

export class WorkflowContractError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, details: ErrorDetails = {}) {
    super(formatWorkflowContractError(code, details));
    this.name = "WorkflowContractError";
    this.code = code;
    this.details = details;
  }
}

function contractError(code: string, details: ErrorDetails = {}): WorkflowContractError {
  return new WorkflowContractError(code, details);
}

// ---------------------------------------------------------------------------
// Валидация формы графа (для автосохранения драфта)
// ---------------------------------------------------------------------------

/**
 * Проверка одной лишь формы графа. Драфт сохраняется автоматически при выходе из
 * редактора, поэтому недостроенная схема (висящие порты, ещё не выбранное
 * событие) сохраняться обязана — полная проверка контракта живёт в
 * `validateWorkflowGraphContract` и применяется при копировании драфта в
 * рабочую версию.
 */
export function isWorkflowGraphShape(value: unknown): value is WorkflowSchema {
  if (!isRecord(value)) return false;
  if (!isFbpGraphKind(value.kind)) return false;
  if (typeof value.schema_version !== "string") return false;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.connections)) return false;
  for (const node of value.nodes) {
    if (!isRecord(node)) return false;
    if (typeof node.id !== "string" || !node.id) return false;
    if (typeof node.type !== "string") return false;
    if (!isRecord(node.position)) return false;
    if (typeof node.position.x !== "number" || typeof node.position.y !== "number") return false;
    if (node.config !== undefined && !isRecord(node.config)) return false;
  }
  for (const connection of value.connections) {
    if (!isRecord(connection)) return false;
    for (const key of ["id", "from", "fromPort", "to", "toPort"]) {
      if (typeof connection[key] !== "string" || !connection[key]) return false;
    }
  }
  return true;
}

export function assertWorkflowGraphShape(value: unknown): asserts value is WorkflowSchema {
  if (!isWorkflowGraphShape(value)) throw contractError("invalid_graph_shape");
}

// ---------------------------------------------------------------------------
// Полная валидация контракта (для сохранения в рабочую версию)
// ---------------------------------------------------------------------------

export interface ValidateWorkflowGraphOptions {
  /** Разрешает schema_version, отличную от текущей (для чтения архивных версий). */
  readonly allowAnyVersion?: boolean;
}

export function validateWorkflowGraphContract(
  graph: unknown,
  options: ValidateWorkflowGraphOptions = {},
): asserts graph is WorkflowSchema {
  assertWorkflowGraphShape(graph);
  if (!options.allowAnyVersion && graph.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    throw contractError("unsupported_schema_version", { version: graph.schema_version });
  }

  const kind = graph.kind;
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw contractError("duplicate_node_id", { nodeId: node.id });
    ids.add(node.id);
    if (!isFbpNodeType(node.type)) throw contractError("unknown_node_type", { nodeType: node.type });
    if (!isNodeTypeAllowedInKind(kind, node.type)) {
      throw contractError("node_type_blocked", { nodeType: node.type, kind });
    }
    validateNodeConfig(node, kind);
  }

  if (kind === "subschema") {
    if (graph.nodes.filter((node) => node.type === "start").length !== 1) throw contractError("single_start");
    if (graph.nodes.filter((node) => node.type === "end").length !== 1) throw contractError("single_end");
  } else if (!graph.nodes.some((node) => node.type === "wait-event")) {
    // Без источника exec схему нечем запустить (решение A1).
    throw contractError("missing_event_source");
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const occupiedDataInputs = new Set<string>();
  for (const connection of graph.connections) {
    const from = nodeById.get(connection.from);
    const to = nodeById.get(connection.to);
    if (!from) throw contractError("unknown_connection_from", { connectionId: connection.id, nodeId: connection.from });
    if (!to) throw contractError("unknown_connection_to", { connectionId: connection.id, nodeId: connection.to });
    validateConnectionPorts(graph, connection, from, to);
    if (!isExecPortId(connection.fromPort)) {
      // На data-вход можно завести ровно одно ребро; на exec-вход — сколько угодно.
      const key = `${connection.to}:${connection.toPort}`;
      if (occupiedDataInputs.has(key)) {
        throw contractError("duplicate_data_input", { nodeId: connection.to, portId: connection.toPort });
      }
      occupiedDataInputs.add(key);
    }
  }
  assertNoExecCycles(graph, nodeById);
}

/** Ключи config, которыми узел не может подменить арендатора/актора (ТЗ §13.13-п.4). */
const FORBIDDEN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "organization_id",
  "organizationId",
  "actor_user_id",
  "context",
]);

function validateNodeConfig(node: WorkflowNode, kind: FbpGraphKind): void {
  const config = isRecord(node.config) ? node.config : {};

  if (node.type === "backend-api") {
    for (const key of FORBIDDEN_CONFIG_KEYS) {
      if (config[key] !== undefined) throw contractError("forbidden_config_key", { nodeId: node.id, key });
    }
  }

  if (node.type === "transform") {
    if (typeof config.code !== "string" || !config.code.trim()) {
      throw contractError("invalid_transform_code", { nodeId: node.id });
    }
    validateConfigPortRows(node, config, "inputs");
    validateConfigPortRows(node, config, "outputs");
  }

  if (node.type === "llm" || node.type === "backend-api") {
    validateConfigPortRows(node, config, "inputs");
    validateConfigPortRows(node, config, "outputs");
  }

  if (node.type === "variable_read") validateConfigPortRows(node, config, "outputs");
  if (node.type === "variable_write") validateConfigPortRows(node, config, "inputs");

  if (node.type === "branch" && !isBranchOperator(config.operator)) {
    throw contractError("invalid_branch_operator", { nodeId: node.id });
  }

  if (node.type === "wait-event" && (typeof config.event_type !== "string" || !config.event_type.trim())) {
    throw contractError("invalid_event_type", { nodeId: node.id });
  }

  if (node.type === "sub_schema" && (typeof config.subSchemaSlug !== "string" || !config.subSchemaSlug.trim())) {
    throw contractError("invalid_sub_schema_slug", { nodeId: node.id });
  }

  if (kind === "subschema" && node.type === "start") validateBoundaryPorts(node, "outputs");
  if (kind === "subschema" && node.type === "end") validateBoundaryPorts(node, "inputs");
}

function validateConfigPortRows(node: WorkflowNode, config: Record<string, unknown>, key: string): void {
  const value = config[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) throw contractError("invalid_config_ports_shape", { nodeId: node.id, key });
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) {
      throw contractError("invalid_config_port_name", { nodeId: node.id, key });
    }
    if (item.type !== undefined && !isPortType(item.type)) {
      throw contractError("invalid_config_port_type", { nodeId: node.id, portType: item.type });
    }
    const name = item.name.trim();
    if (seen.has(name)) throw contractError("duplicate_config_port", { nodeId: node.id, name });
    seen.add(name);
  }
}

function validateBoundaryPorts(node: WorkflowNode, key: "inputs" | "outputs"): void {
  const config = isRecord(node.config) ? node.config : {};
  const value = config[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) throw contractError("invalid_config_ports_shape", { nodeId: node.id, key });
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw contractError("invalid_boundary_port_id", { nodeId: node.id, portId: "" });
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!BOUNDARY_PORT_ID_PATTERN.test(id)) {
      throw contractError("invalid_boundary_port_id", { nodeId: node.id, portId: id });
    }
    if (!isBoundaryPortType(item.type)) {
      throw contractError("invalid_boundary_port_type", { nodeId: node.id, portType: item.type });
    }
    if (seen.has(id)) throw contractError("duplicate_boundary_port", { nodeId: node.id, portId: id });
    seen.add(id);
  }
}

function validateConnectionPorts(
  graph: WorkflowSchema,
  connection: WorkflowConnection,
  from: WorkflowNode,
  to: WorkflowNode,
): void {
  const fromExec = isExecPortId(connection.fromPort);
  const toExec = isExecPortId(connection.toPort);
  if (fromExec || toExec) {
    if (!fromExec || !toExec) throw contractError("mixed_port_kinds", { connectionId: connection.id });
    if (!execOutputPortIds(from).includes(connection.fromPort)) {
      throw contractError("missing_exec_output", { nodeId: from.id, portId: connection.fromPort });
    }
    if (!execInputPortIds(to, graph).includes(connection.toPort)) {
      throw contractError("missing_exec_input", { nodeId: to.id, portId: connection.toPort });
    }
    return;
  }

  const ports = { from: getNodePortDefinitions(from, graph), to: getNodePortDefinitions(to, graph) };
  if (!ports.from.outputs.some((port) => port.id === connection.fromPort)) {
    throw contractError("missing_data_output", { nodeId: from.id, portId: connection.fromPort });
  }
  if (!ports.to.inputs.some((port) => port.id === connection.toPort)) {
    throw contractError("missing_data_input", { nodeId: to.id, portId: connection.toPort });
  }

  const fromType = getNodeOutputPortType(graph, from, connection.fromPort);
  const toType = getNodeInputPortType(graph, to, connection.toPort);
  if (!arePortTypesCompatible(fromType, toType)) {
    throw contractError("incompatible_ports", {
      connectionId: connection.id,
      fromNodeId: from.id,
      fromPortId: connection.fromPort,
      fromType,
      toNodeId: to.id,
      toPortId: connection.toPort,
      toType,
    });
  }
}

function assertNoExecCycles(graph: WorkflowSchema, nodeById: Map<string, WorkflowNode>): void {
  const outgoing = new Map<string, string[]>();
  for (const connection of graph.connections) {
    if (!isExecPortId(connection.fromPort)) continue;
    if (!nodeById.has(connection.from) || !nodeById.has(connection.to)) continue;
    const list = outgoing.get(connection.from) ?? [];
    list.push(connection.to);
    outgoing.set(connection.from, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw contractError("exec_cycle", { nodeId });
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of graph.nodes) visit(node.id);
}

// ---------------------------------------------------------------------------
// Проверка одной связи (для редактора: подсветка при перетаскивании)
// ---------------------------------------------------------------------------

export interface ConnectAttempt {
  readonly source: string | null;
  readonly sourceHandle: string | null;
  readonly target: string | null;
  readonly targetHandle: string | null;
}

export interface ConnectCheckResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Можно ли соединить порты. Используется редактором в `isValidConnection`, чтобы
 * подсветить недопустимые цели прямо во время перетаскивания связи.
 */
export function canConnectPorts(graph: WorkflowSchema, attempt: ConnectAttempt): ConnectCheckResult {
  const { source, sourceHandle, target, targetHandle } = attempt;
  if (!source || !sourceHandle || !target || !targetHandle) {
    return { valid: false, reason: "Не указан порт" };
  }
  if (source === target) return { valid: false, reason: "Нельзя соединить узел с самим собой" };

  const from = graph.nodes.find((node) => node.id === source);
  const to = graph.nodes.find((node) => node.id === target);
  if (!from || !to) return { valid: false, reason: "Узел не найден" };

  const connection: WorkflowConnection = {
    id: "candidate",
    from: source,
    fromPort: sourceHandle,
    to: target,
    toPort: targetHandle,
  };

  try {
    validateConnectionPorts(graph, connection, from, to);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "Несовместимые порты" };
  }

  const duplicate = graph.connections.some(
    (item) =>
      item.from === source && item.fromPort === sourceHandle && item.to === target && item.toPort === targetHandle,
  );
  if (duplicate) return { valid: false, reason: "Такая связь уже есть" };

  if (!isExecPortId(sourceHandle)) {
    const occupied = graph.connections.some(
      (item) => item.to === target && item.toPort === targetHandle && !isExecPortId(item.fromPort),
    );
    if (occupied) {
      return { valid: false, reason: formatWorkflowContractError("duplicate_data_input", { nodeId: target, portId: targetHandle }) };
    }
  }

  const candidate: WorkflowSchema = { ...graph, connections: [...graph.connections, connection] };
  try {
    assertNoExecCycles(candidate, new Map(candidate.nodes.map((node) => [node.id, node])));
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "Связь образует цикл" };
  }

  return { valid: true };
}
