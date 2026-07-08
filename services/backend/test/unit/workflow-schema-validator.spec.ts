import { validateWorkflowSchema } from "../../src/modules/workflow/workflow-schema.validator";

function schemaWithTransform(config: Record<string, unknown>): Record<string, unknown> {
  return {
    entry: "start",
    nodes: [{ id: "start", type: "transform", config }],
    schema_version: "1.0.0",
  };
}

describe("workflow-schema.validator transform code mode", () => {
  it("принимает mode=code и не запрещает опасные токены на этапе сохранения", () => {
    const result = validateWorkflowSchema(
      schemaWithTransform({
        mode: "code",
        code: "return typeof process + ':' + typeof require + ':' + typeof constructor;",
      }),
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("оставляет expression-режим обратно совместимым и всё ещё валидирует whitelist", () => {
    expect(validateWorkflowSchema(schemaWithTransform({ expression: { op: "input" } }))).toEqual({
      valid: true,
      errors: [],
    });

    const rejected = validateWorkflowSchema(
      schemaWithTransform({ expression: { op: "eval", args: [] } }),
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.some((error) => error.path === "$.nodes[0].config.expression.op")).toBe(true);
  });

  it("требует явный mode=code для поля code", () => {
    const result = validateWorkflowSchema(schemaWithTransform({ code: "return input;" }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === "$.nodes[0].config.mode")).toBe(true);
  });
});
