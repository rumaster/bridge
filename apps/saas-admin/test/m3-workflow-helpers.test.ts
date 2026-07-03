import { describe, expect, it } from "vitest";

import type { WorkflowNode, WorkflowNodeType, WorkflowSchema } from "../src/api/client/types";
import {
  SAFE_WORKFLOW_NODE_TYPES,
  createWorkflowConnection,
  createWorkflowNode,
  isSafeWorkflowNodeType,
  validateWorkflowSchema,
  workflowNodeMutatesData,
  workflowNodePrimaryField
} from "../src/shared/workflow";

function node(overrides: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return {
    id: overrides.id,
    type: overrides.type ?? "wait_event",
    label: overrides.label ?? "Узел",
    config: overrides.config ?? {},
    position: overrides.position ?? { x: 0, y: 0 }
  };
}

describe("safe workflow node set (ТЗ §13.13)", () => {
  it("ограничивает палитру ровно шестью безопасными типами", () => {
    expect(SAFE_WORKFLOW_NODE_TYPES).toEqual([
      "wait_event",
      "kb_search",
      "llm_call",
      "branch",
      "transform",
      "backend_api_call"
    ]);
  });

  it("считает узел изменяющим данные только для вызова Backend API (ТЗ §13.5)", () => {
    const mutating = SAFE_WORKFLOW_NODE_TYPES.filter((type) => workflowNodeMutatesData(type));
    expect(mutating).toEqual(["backend_api_call"]);
  });

  it("распознаёт безопасные типы и отвергает произвольные", () => {
    expect(isSafeWorkflowNodeType("transform")).toBe(true);
    expect(isSafeWorkflowNodeType("db_write")).toBe(false);
  });
});

describe("createWorkflowNode / createWorkflowConnection", () => {
  it("создаёт узел с детерминированным id и пустым основным полем", () => {
    const created = createWorkflowNode("kb_search", []);
    const primary = workflowNodePrimaryField("kb_search");

    expect(created.id).toBe("node-kb_search-1");
    expect(created.type).toBe("kb_search");
    expect(created.config).toEqual({ [primary.key]: "" });
    expect(created.label.trim().length).toBeGreaterThan(0);
  });

  it("гарантирует уникальность id при совпадении префикса", () => {
    const existing = [node({ id: "node-branch-1", type: "branch" })];
    const created = createWorkflowNode("branch", existing);

    expect(created.id).toBe("node-branch-2");
  });

  it("создаёт связь с детерминированным id", () => {
    const first = createWorkflowConnection("a", "b", []);
    const second = createWorkflowConnection("b", "c", [first]);

    expect(first).toEqual({ id: "conn-1", from: "a", to: "b" });
    expect(second.id).toBe("conn-2");
  });
});

describe("validateWorkflowSchema", () => {
  const valid: WorkflowSchema = {
    nodes: [
      node({ id: "n1", type: "wait_event", label: "Событие" }),
      node({ id: "n2", type: "backend_api_call", label: "Вызов API" })
    ],
    connections: [{ id: "conn-1", from: "n1", to: "n2" }]
  };

  it("принимает корректную схему из безопасных узлов", () => {
    const result = validateWorkflowSchema(valid);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("требует хотя бы один узел", () => {
    const result = validateWorkflowSchema({ nodes: [], connections: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Схема должна содержать хотя бы один узел.");
  });

  it("отвергает дублирующиеся идентификаторы узлов", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "dup", label: "A" }), node({ id: "dup", label: "B" })],
      connections: [{ id: "conn-1", from: "dup", to: "dup" }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Обнаружены дублирующиеся идентификаторы узлов.");
  });

  it("отвергает запрещённый тип узла (вне безопасного набора)", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", type: "db_write" as WorkflowNodeType, label: "Прямая запись" })],
      connections: []
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("безопасный набор"))).toBe(true);
  });

  it("требует непустую метку узла", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "  " })],
      connections: []
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("метка"))).toBe(true);
  });

  it("запрещает связь узла на самого себя", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "A" }), node({ id: "n2", label: "B" })],
      connections: [{ id: "conn-1", from: "n1", to: "n1" }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Узел не может ссылаться сам на себя.");
  });

  it("отвергает связь на несуществующий узел", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "A" }), node({ id: "n2", label: "B" })],
      connections: [{ id: "conn-1", from: "n1", to: "ghost" }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Связь ссылается на несуществующий узел.");
  });

  it("требует связь при наличии нескольких узлов", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "A" }), node({ id: "n2", label: "B" })],
      connections: []
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Соедините узлы хотя бы одной связью.");
  });
});
