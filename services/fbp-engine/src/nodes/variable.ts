import { configPortRows } from "@bridge/contracts/c5-workflow";

/**
 * Переменные экземпляра (Ревизия 2026-07-15). Пара узлов сознательно
 * несимметрична по exec-портам:
 *
 * `variable_read` — чистое чтение, поэтому exec-портов не имеет и вычисляется
 * лениво, когда значение понадобилось.
 *
 * `variable_write` — побочный эффект: момент записи важен, иначе читатель мог бы
 * получить значение до или после записи в зависимости от того, кто первым
 * дёрнул. Поэтому он стоит в exec-потоке и имеет exec-порты.
 *
 * Имена переменных = имена портов (`config.outputs` / `config.inputs`).
 */
export const variableReadNode = {
  type: "variable_read",

  validate() {
    // Имена и типы портов проверены контрактом C5 на сохранении схемы.
  },

  execute({ node, ctx }) {
    const rows = portRows(node, "outputs");
    const outputs = {};
    for (const row of rows) outputs[row.name] = ctx.getVariable(row.name);
    return { outputs };
  },
};

export const variableWriteNode = {
  type: "variable_write",

  validate() {
    // Имена и типы портов проверены контрактом C5 на сохранении схемы.
  },

  execute({ node, input, ctx }) {
    const rows = portRows(node, "inputs");
    const written = [];
    for (const row of rows) {
      if (!Object.hasOwn(input, row.name)) continue;
      ctx.setVariable(row.name, input[row.name]);
      written.push(row.name);
    }
    return { outputs: {}, log: { variables: written } };
  },
};

function portRows(node, key) {
  const rows = configPortRows(node.config?.[key]);
  return rows.length > 0 ? rows : [{ name: "value", type: "any" }];
}
