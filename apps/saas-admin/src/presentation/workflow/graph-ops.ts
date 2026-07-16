import { getNodePortDefinitions, isExecPortId } from "@bridge/contracts/c5-workflow";
import type { WorkflowConnection, WorkflowNode, WorkflowSchema } from "@bridge/contracts/c5-workflow";

import { canConnectWorkflowPorts, createWorkflowConnection } from "../../shared/workflow";

/**
 * Операции над графом схемы — ЧИСТЫЕ функции вне React.
 *
 * Компонент холста только зовёт `connectGraphPorts(graph, connection)` и кладёт
 * результат в состояние. Так логику графа можно проверить без рендера, а сам
 * холст остаётся тонким: он про перетаскивание, а не про правила схемы.
 *
 * Правила портов и совместимости не живут здесь вовсе — их знает контракт C5,
 * общий с Backend и движком.
 */

export class GraphOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphOperationError";
  }
}

export interface ConnectionAttempt {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

/**
 * Граф без рёбер, которые замещает новое соединение.
 *
 * На data-вход контракт разрешает ровно одно ребро и отвергает попытку занять
 * подключённый вход. Но перетащить связь на занятый вход — это «замени», а не
 * «ошибка»: оператор именно этого и хочет. Поэтому старое ребро снимается ДО
 * проверки, и контракт проверяет ровно тот граф, который получится.
 *
 * Для exec-входов замещения нет: там мультиконнект разрешён, а в `merge` он и
 * есть смысл узла.
 */
function withReplacedInput(graph: WorkflowSchema, attempt: ConnectionAttempt): WorkflowSchema {
  const { target, targetHandle } = attempt;
  if (!target || !targetHandle || isExecPortId(targetHandle)) return graph;

  return {
    ...graph,
    connections: graph.connections.filter(
      (connection) => connection.to !== target || connection.toPort !== targetHandle,
    ),
  };
}

/**
 * Можно ли соединить порты — с учётом замещения. Холст зовёт её в
 * `isValidConnection`, чтобы подсветить недопустимую цель во время перетаскивания.
 *
 * Проверять надо именно граф ПОСЛЕ замещения: иначе занятый data-вход
 * подсвечивался бы запрещённым, а `connectGraphPorts` его бы принял — подсветка
 * врала бы про то, что произойдёт по отпусканию.
 */
export function canConnectGraphPorts(
  graph: WorkflowSchema,
  attempt: ConnectionAttempt,
): { valid: boolean; reason?: string } {
  return canConnectWorkflowPorts(withReplacedInput(graph, attempt), attempt);
}

/**
 * Соединить порты. Бросает с человекочитаемой причиной — холст показывает её
 * текстом. Проверка не дублируется: та же `canConnectGraphPorts`, что и в
 * `isValidConnection`.
 */
export function connectGraphPorts(graph: WorkflowSchema, attempt: ConnectionAttempt): WorkflowSchema {
  const base = withReplacedInput(graph, attempt);
  const check = canConnectWorkflowPorts(base, attempt);
  if (!check.valid) {
    throw new GraphOperationError(check.reason ?? "Недопустимое соединение");
  }

  const connection = createWorkflowConnection(
    attempt.source as string,
    attempt.sourceHandle as string,
    attempt.target as string,
    attempt.targetHandle as string,
    base.connections,
  );

  return { ...base, connections: [...base.connections, connection] };
}

export function addGraphNode(graph: WorkflowSchema, node: WorkflowNode): WorkflowSchema {
  return { ...graph, nodes: [...graph.nodes, node] };
}

/**
 * Удалить узлы вместе с их рёбрами: связь на несуществующий узел контракт
 * отвергает, так что оставить её — значит сломать схему молча.
 */
export function removeGraphNodes(graph: WorkflowSchema, nodeIds: readonly string[]): WorkflowSchema {
  const removed = new Set(nodeIds);
  if (removed.size === 0) return graph;

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    connections: graph.connections.filter(
      (connection) => !removed.has(connection.from) && !removed.has(connection.to),
    ),
  };
}

export function removeGraphConnections(
  graph: WorkflowSchema,
  connectionIds: readonly string[],
): WorkflowSchema {
  const removed = new Set(connectionIds);
  if (removed.size === 0) return graph;

  return {
    ...graph,
    connections: graph.connections.filter((connection) => !removed.has(connection.id)),
  };
}

export function moveGraphNode(
  graph: WorkflowSchema,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowSchema {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

export function patchGraphNode(
  graph: WorkflowSchema,
  nodeId: string,
  patch: Partial<WorkflowNode>,
): WorkflowSchema {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

/**
 * Изменить конфиг узла. Рёбра НЕ чистятся намеренно.
 *
 * Состав портов зависит от конфига: переименовал порт в панели свойств — старого
 * порта не стало. Ребро на него при этом остаётся: контракт восстанавливает такой
 * порт как динамический типа `any` (см. `getNodePortDefinitions`), поэтому граф
 * остаётся валидным, а связь — видимой. Чистка здесь рвала бы связь на каждом
 * нажатии клавиши в поле имени порта.
 */
export function patchGraphNodeConfig(
  graph: WorkflowSchema,
  nodeId: string,
  config: Record<string, unknown>,
): WorkflowSchema {
  return patchGraphNode(graph, nodeId, { config });
}

/** Data-входы узла: имена портов, которые можно подставить в промпт или код. */
export function dataInputPortIds(graph: WorkflowSchema, node: WorkflowNode): string[] {
  return getNodePortDefinitions(node, graph)
    .inputs.filter((port) => !isExecPortId(port.id))
    .map((port) => port.id);
}

/**
 * Подпись состава портов узла. Нужна холсту: xyflow не перерегистрирует хэндлы,
 * если состав портов сменился, а габариты узла — нет (issue #394). Строка меняется
 * при любой правке портов и служит триггером `updateNodeInternals`.
 */
export function portSignature(graph: WorkflowSchema, node: WorkflowNode): string {
  const ports = getNodePortDefinitions(node, graph);
  return [...ports.inputs, ...ports.outputs]
    .map((port) => `${port.direction}:${port.id}:${port.type}`)
    .join("|");
}

export function findGraphNode(
  graph: WorkflowSchema | null,
  nodeId: string | null,
): WorkflowNode | null {
  if (!graph || !nodeId) return null;
  return graph.nodes.find((node) => node.id === nodeId) ?? null;
}

/** Узлы «Ожидание события» — точки входа схемы 2.0 и варианты старта тест-прогона. */
export function waitEventNodes(graph: WorkflowSchema): WorkflowNode[] {
  return graph.nodes.filter((node) => node.type === "wait-event");
}

export function cloneGraph(graph: WorkflowSchema): WorkflowSchema {
  return JSON.parse(JSON.stringify(graph)) as WorkflowSchema;
}

export type { WorkflowConnection, WorkflowNode, WorkflowSchema };
