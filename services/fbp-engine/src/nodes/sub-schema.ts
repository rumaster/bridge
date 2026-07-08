import { WorkflowExecutionError } from "../core/errors.js";

/**
 * Узел-ссылка на переиспользуемую субсхему. В сохранённой Workflow-схеме хранится
 * только `config.subSchemaSlug`; сам граф субсхемы подставляет Backend при
 * старте экземпляра или внешний рантайм через callback.
 */
export const subSchemaNode = {
  type: "sub_schema",

  validate(config, { path, errors }) {
    if (!isRecord(config)) {
      errors.push({ path, message: "Узел sub_schema требует объект config." });
      return;
    }
    if (config.bodyGraph !== undefined) {
      errors.push({
        path: `${path}.bodyGraph`,
        message: "Узел sub_schema хранит только ссылку subSchemaSlug; embedded bodyGraph запрещён.",
      });
    }
    if (typeof config.subSchemaSlug !== "string" || config.subSchemaSlug.trim() === "") {
      errors.push({ path: `${path}.subSchemaSlug`, message: "Узел sub_schema требует непустой subSchemaSlug." });
    }
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

    return {
      output: result.output ?? null,
      port: "out",
      log: { sub_schema_slug: slug.trim(), status: result.status },
    };
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
