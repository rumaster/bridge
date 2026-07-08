/**
 * Модель графа Workflow: узлы (Node) и соединения (Connection). Ядро исполнения
 * предметно-нейтрально (ТЗ §13.13-п.1) — это лишь топология: какие узлы есть и
 * какой узел исполняется следующим при данном выходном порту.
 *
 * Соединение: `{ from, fromPort, to, toPort }`. Большинство узлов эмитят порт
 * "out"; узел `branch` эмитит "true"/"false". `port` читается только как
 * legacy fallback для старых опубликованных схем до Этапа 1.
 */
export const DEFAULT_PORT = "out";

export function buildGraph(schema) {
  const nodeMap = new Map();
  for (const node of schema.nodes ?? []) {
    nodeMap.set(node.id, node);
  }

  const connectionsFrom = new Map();
  for (const connection of schema.connections ?? []) {
    const port = connection.fromPort ?? connection.port ?? DEFAULT_PORT;
    if (!connectionsFrom.has(connection.from)) {
      connectionsFrom.set(connection.from, new Map());
    }
    connectionsFrom.get(connection.from).set(port, connection.to);
  }

  return {
    entry: schema.entry,
    nodeMap,
    getNode(nodeId) {
      return nodeMap.get(nodeId) ?? null;
    },
    /** Следующий узел из `fromNodeId` по выходному порту `port` (или null). */
    next(fromNodeId, port = DEFAULT_PORT) {
      const ports = connectionsFrom.get(fromNodeId);
      if (!ports) {
        return null;
      }
      return ports.get(port) ?? null;
    },
  };
}

/**
 * Найти цикл в графе переходов (обход в глубину). Возвращает массив id узлов
 * цикла или `null`. DAG обязателен на этапе сохранения схемы — это гарантирует
 * завершимость исполнения без «неограниченных циклов» (ТЗ §13.13-п.5).
 */
export function findCycle(schema) {
  const adjacency = new Map();
  for (const node of schema.nodes ?? []) {
    adjacency.set(node.id, []);
  }
  for (const connection of schema.connections ?? []) {
    if (adjacency.has(connection.from) && adjacency.has(connection.to)) {
      adjacency.get(connection.from).push(connection.to);
    }
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map([...adjacency.keys()].map((id) => [id, WHITE]));
  const stack = [];

  function visit(nodeId) {
    color.set(nodeId, GREY);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const state = color.get(next);
      if (state === GREY) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (state === WHITE) {
        const cycle = visit(next);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
    return null;
  }

  for (const nodeId of adjacency.keys()) {
    if (color.get(nodeId) === WHITE) {
      const cycle = visit(nodeId);
      if (cycle) {
        return cycle;
      }
    }
  }
  return null;
}
