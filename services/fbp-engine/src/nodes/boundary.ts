import { nodeBoundaryPorts } from "@bridge/contracts/c5-workflow";

/**
 * Границы субсхемы (ТЗ §13.13, Ревизия 2026-07-15).
 *
 * `start` раздаёт то, что субсхеме передал вызывающий узел: порты объявлены в
 * `config.outputs`, значения приходят во входных параметрах дочернего контекста.
 * Отдаются ТОЛЬКО объявленные порты — субсхема не должна видеть лишнего.
 *
 * `end` — зеркало: его входы и есть результат субсхемы, который исполнитель
 * возвращает наружу.
 */
export const startNode = {
  type: "start",

  validate() {
    // Граничные порты проверены контрактом C5 на сохранении схемы.
  },

  execute({ node, ctx }) {
    const params = ctx.params ?? {};
    const outputs = {};
    for (const port of nodeBoundaryPorts(node, "start")) {
      outputs[port.id] = Object.hasOwn(params, port.id) ? params[port.id] : null;
    }
    return { outputs };
  },
};

export const endNode = {
  type: "end",

  validate() {
    // Граничные порты проверены контрактом C5 на сохранении схемы.
  },

  execute({ input }) {
    return { outputs: { ...input } };
  },
};
