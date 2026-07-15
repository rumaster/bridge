import { isExecPortId } from "@bridge/contracts/c5-workflow";

/**
 * Топология графа Workflow. Ядро предметно-нейтрально (ТЗ §13.13-п.1) — здесь
 * только «какие узлы есть» и «кто с кем связан».
 *
 * Ревизия 2026-07-15: связи разделены на два класса, потому что модель стала
 * гибридом push/pull. Exec-связи задают порядок исполнения и могут ветвиться
 * (один выход → несколько целей: так начинаются параллельные потоки, которые
 * потом сводит узел merge). Data-связи тянут значения: на один data-вход ведёт
 * ровно одно ребро (проверяет контракт), поэтому источник у входа единственный.
 *
 * Прежняя карта `Map<from, Map<port, to>>` для новой модели непригодна: она
 * физически вмещала лишь одну цель на порт.
 */
export function buildGraph(schema) {
  const nodeMap = new Map();
  for (const node of schema.nodes ?? []) {
    nodeMap.set(node.id, node);
  }

  const execFrom = new Map();
  const dataTo = new Map();

  for (const connection of schema.connections ?? []) {
    if (isExecPortId(connection.fromPort)) {
      const list = execFrom.get(connection.from) ?? [];
      list.push(connection);
      execFrom.set(connection.from, list);
      continue;
    }
    const list = dataTo.get(connection.to) ?? [];
    list.push(connection);
    dataTo.set(connection.to, list);
  }

  return {
    nodeMap,
    getNode(nodeId) {
      return nodeMap.get(nodeId) ?? null;
    },
    /** Исходящие exec-связи узла (все порты). */
    execConnectionsFrom(nodeId) {
      return execFrom.get(nodeId) ?? [];
    },
    /** Входящие data-связи узла: по одной на занятый вход. */
    dataConnectionsTo(nodeId) {
      return dataTo.get(nodeId) ?? [];
    },
    /** Сколько exec-потоков сходится в узел — размер барьера merge. */
    incomingExecCount(nodeId) {
      let count = 0;
      for (const list of execFrom.values()) {
        for (const connection of list) {
          if (connection.to === nodeId) count += 1;
        }
      }
      return count;
    },
  };
}
