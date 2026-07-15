/**
 * Узел ветвления (ТЗ §13.4, Ревизия 2026-07-15).
 *
 * Раньше условие было Transform-выражением; теперь это оператор над двумя
 * data-входами: `value` — то, что сравниваем, `right` — с чем. Правый операнд
 * можно не подключать, а задать константой в `config.right` — типовой случай
 * «сравнить с 5» не должен требовать отдельного узла ради литерала.
 * Подключённый порт имеет приоритет над константой конфига.
 *
 * Результат влияет не на данные, а на маршрут: узел эмитит exec-порт true/false.
 */
export const branchNode = {
  type: "branch",

  validate() {
    // Оператор проверен контрактом C5 на сохранении схемы.
  },

  execute({ node, input }) {
    const config = node.config ?? {};
    const operator = config.operator ?? "truthy";
    const left = input.value;
    const right = Object.hasOwn(input, "right") ? input.right : config.right;
    const outcome = evaluateCondition(left, operator, right);
    return {
      outputs: {},
      execPort: outcome ? "true" : "false",
      log: { operator, branch: outcome ? "true" : "false" },
    };
  },
};

export function evaluateCondition(left, operator, right) {
  switch (operator) {
    case "exists":
      return left !== undefined && left !== null;
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "truthy":
    default:
      return Boolean(left);
  }
}
