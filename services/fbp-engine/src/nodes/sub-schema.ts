import { WorkflowExecutionError } from "../core/errors.js";

/**
 * Узел-ссылка на переиспользуемую субсхему. В сохранённой Workflow-схеме хранится
 * только `config.subSchemaSlug`; сам граф субсхемы подставляет Backend при
 * старте экземпляра или внешний рантайм через callback.
 */
export const subSchemaNode = {
  type: "sub_schema",

  validate() {
    // Наличие subSchemaSlug проверяет контракт C5 на сохранении схемы.
  },

  async execute({ node, input, runSubSchema }) {
    const slug = node.config?.subSchemaSlug;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new WorkflowExecutionError("invalid_subschema_ref", "Узел sub_schema требует непустой subSchemaSlug.", {
        nodeId: node.id,
        nodeType: "sub_schema",
      });
    }
    if (typeof runSubSchema !== "function") {
      throw new WorkflowExecutionError(
        "subschema_resolver_missing",
        "Для исполнения sub_schema не передан resolver субсхем.",
        { nodeId: node.id, nodeType: "sub_schema" },
      );
    }

    const result = await runSubSchema(slug.trim(), input);
    if (result?.status !== "completed") {
      throw new WorkflowExecutionError(
        "subschema_not_completed",
        `Субсхема "${slug}" завершилась статусом "${result?.status ?? "unknown"}".`,
        { nodeId: node.id, nodeType: "sub_schema" },
      );
    }

    // Выходы узла — граничные end-порты субсхемы: они уже разложены по портам
    // её узлом end, поэтому отдаются как есть.
    return {
      outputs: result.output ?? {},
      log: { sub_schema_slug: slug.trim(), status: result.status },
    };
  },
};
