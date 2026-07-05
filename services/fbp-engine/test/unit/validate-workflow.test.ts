import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkflowSchemaValidationError } from "../../src/core/errors.js";
import {
  assertWorkflowSchema,
  validateWorkflowSchema,
} from "../../src/schema/validate-workflow.js";

function validSchema() {
  return {
    schema_version: "1.0.0",
    entry: "start",
    nodes: [
      { id: "start", type: "transform", config: { expression: { op: "input" } } },
      {
        id: "call",
        type: "backend-api",
        input: { name: { kind: "node", node: "start", path: ["name"] } },
        config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
      },
    ],
    connections: [{ from: "start", to: "call" }],
  };
}

function pathsOf(result) {
  return result.errors.map((error) => error.path);
}

describe("Валидация схемы Workflow на этапе сохранения", () => {
  it("принимает корректную схему", () => {
    const result = validateWorkflowSchema(validSchema());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  });

  it("отвергает неверную schema_version", () => {
    const schema = validSchema();
    schema.schema_version = "2.0.0";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.schema_version"));
  });

  it("отвергает неизвестный тип узла", () => {
    const schema = validSchema();
    schema.nodes[0].type = "sql-exec";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[0].type"));
  });

  it("отвергает дублирующиеся id узлов", () => {
    const schema = validSchema();
    schema.nodes[1].id = "start";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.endsWith(".id")));
  });

  it("ОТВЕРГАЕТ операцию Transform вне whitelist на этапе сохранения (§13.13-п.5)", () => {
    const schema = validSchema();
    schema.nodes[0].config.expression = { op: "eval", args: [{ op: "lit", value: "code" }] };
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.includes(".expression")));
  });

  it("отвергает попытку узла Backend API подменить арендатора (§13.13-п.4)", () => {
    const schema = validSchema();
    schema.nodes[1].config.organization_id = "org-foreign";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.endsWith(".organization_id")));
  });

  it("отвергает путь Backend API вне публичного /api/v1", () => {
    const schema = validSchema();
    schema.nodes[1].config.path = "/internal/db/records";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.endsWith(".path")));
  });

  it("требует ациклический граф (DAG)", () => {
    const schema = validSchema();
    schema.connections.push({ from: "call", to: "start" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.connections"));
  });

  it("отвергает entry, ссылающийся на несуществующий узел", () => {
    const schema = validSchema();
    schema.entry = "missing";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.entry"));
  });

  it("отвергает соединение в несуществующий узел", () => {
    const schema = validSchema();
    schema.connections.push({ from: "call", to: "ghost" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.endsWith(".to")));
  });

  it("отвергает ссылку входа на несуществующий узел", () => {
    const schema = validSchema();
    schema.nodes[1].input = { x: { kind: "node", node: "nobody", path: [] } };
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path) => path.endsWith(".node")));
  });

  it("assertWorkflowSchema бросает WorkflowSchemaValidationError со списком ошибок", () => {
    const schema = validSchema();
    schema.nodes[0].type = "unknown";
    assert.throws(
      () => assertWorkflowSchema(schema),
      (error) => error instanceof WorkflowSchemaValidationError && Array.isArray(error.errors) && error.errors.length > 0,
    );
  });

  it("assertWorkflowSchema возвращает схему без изменений при корректном вводе", () => {
    const schema = validSchema();
    assert.equal(assertWorkflowSchema(schema), schema);
  });
});
