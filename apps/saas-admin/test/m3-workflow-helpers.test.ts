import { FBP_NODE_TYPES } from "@bridge/contracts/c5-workflow";
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
    type: overrides.type ?? "wait-event",
    label: overrides.label ?? "Узел",
    config: overrides.config ?? {},
    position: overrides.position ?? { x: 0, y: 0 }
  };
}

describe("safe workflow node set (ТЗ §13.13)", () => {
  // Список сверяется с каталогом контракта, а не переписывается сюда руками:
  // именно расхождение копий каталога и породило дефект D8. Каталог 2.0 добавил
  // variable_read/variable_write/merge и границы субсхем start/end.
  it("ограничивает палитру каноническими типами C5", () => {
    expect(SAFE_WORKFLOW_NODE_TYPES).toEqual([...FBP_NODE_TYPES]);
    expect(SAFE_WORKFLOW_NODE_TYPES).toContain("wait-event");
    expect(SAFE_WORKFLOW_NODE_TYPES).not.toContain("db_write");
  });

  it("считает узел изменяющим данные только для вызова Backend API (ТЗ §13.5)", () => {
    const mutating = SAFE_WORKFLOW_NODE_TYPES.filter((type) => workflowNodeMutatesData(type));
    expect(mutating).toEqual(["backend-api"]);
  });

  it("распознаёт безопасные типы и отвергает произвольные", () => {
    expect(isSafeWorkflowNodeType("transform")).toBe(true);
    expect(isSafeWorkflowNodeType("wait_event")).toBe(false);
    expect(isSafeWorkflowNodeType("db_write")).toBe(false);
  });
});

describe("createWorkflowNode / createWorkflowConnection", () => {
  it("создаёт узел с детерминированным id и пустым основным полем", () => {
    const created = createWorkflowNode("knowledge-base-search", []);
    const primary = workflowNodePrimaryField("knowledge-base-search");

    expect(created.id).toBe("node-knowledge-base-search-1");
    expect(created.type).toBe("knowledge-base-search");
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

    expect(first).toEqual({ id: "conn-1", from: "a", fromPort: "out", to: "b", toPort: "in" });
    expect(second.id).toBe("conn-2");
  });

  it("создаёт sub_schema как ссылку без embedded bodyGraph", () => {
    const created = createWorkflowNode("sub_schema", []);

    expect(created.id).toBe("node-sub_schema-1");
    expect(created.config).toEqual({ subSchemaSlug: "" });
    expect(created.config.bodyGraph).toBeUndefined();
  });
});

describe("validateWorkflowSchema", () => {
  const valid: WorkflowSchema = {
    nodes: [
      node({ id: "n1", type: "wait-event", label: "Событие" }),
      node({ id: "n2", type: "backend-api", label: "Вызов API" })
    ],
    connections: [{ id: "conn-1", from: "n1", fromPort: "out", to: "n2", toPort: "in" }]
  };

  it("принимает корректную схему из безопасных узлов", () => {
    const result = validateWorkflowSchema(valid);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("проверяет bodyGraph внутри узла, если он явно задан", () => {
    const result = validateWorkflowSchema({
      nodes: [
        node({
          id: "sub",
          type: "transform",
          label: "Трансформация",
          config: { bodyGraph: { nodes: [], connections: [] } }
        })
      ],
      connections: []
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("bodyGraph узла «Трансформация»: Схема должна содержать хотя бы один узел.");
  });

  it("отвергает embedded bodyGraph у sub_schema", () => {
    const result = validateWorkflowSchema({
      nodes: [
        node({
          id: "sub",
          type: "sub_schema",
          label: "Переиспользуемая схема",
          config: {
            subSchemaSlug: "support-common-context",
            bodyGraph: { nodes: [], connections: [] }
          }
        })
      ],
      connections: []
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Узел «Переиспользуемая схема» хранит только ссылку на субсхему без bodyGraph.");
  });

  it("требует хотя бы один узел", () => {
    const result = validateWorkflowSchema({ nodes: [], connections: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Схема должна содержать хотя бы один узел.");
  });

  it("отвергает дублирующиеся идентификаторы узлов", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "dup", label: "A" }), node({ id: "dup", label: "B" })],
      connections: [{ id: "conn-1", from: "dup", fromPort: "out", to: "dup", toPort: "in" }]
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
      connections: [{ id: "conn-1", from: "n1", fromPort: "out", to: "n1", toPort: "in" }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Узел не может ссылаться сам на себя.");
  });

  it("отвергает связь на несуществующий узел", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "A" }), node({ id: "n2", label: "B" })],
      connections: [{ id: "conn-1", from: "n1", fromPort: "out", to: "ghost", toPort: "in" }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Связь ссылается на несуществующий узел.");
  });

  it("требует fromPort/toPort у связи", () => {
    const result = validateWorkflowSchema({
      nodes: [node({ id: "n1", label: "A" }), node({ id: "n2", label: "B" })],
      connections: [{ id: "conn-1", from: "n1", to: "n2" } as WorkflowSchema["connections"][number]]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Связь должна указывать fromPort и toPort.");
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
