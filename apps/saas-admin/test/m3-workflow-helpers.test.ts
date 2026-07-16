import { FBP_NODE_TYPES, WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { describe, expect, it } from "vitest";

import type { WorkflowNode, WorkflowSchema } from "../src/api/client/types";
import {
  createWorkflowConnection,
  createWorkflowNode,
  createWorkflowSchema,
  isSafeWorkflowNodeType,
  validateWorkflowSchema,
  workflowNodeMutatesData,
  workflowNodePalette,
  workflowNodePrimaryField
} from "../src/shared/workflow";

/**
 * Ревизия 2026-07-15 (этап 7). Тесты перенесены на контракт 2.0.
 *
 * Что ушло и почему: проверки `bodyGraph` — концепт удалён целиком (дефект D6),
 * его не «починили», а признали мёртвым: фронт его создавал и валидировал,
 * бэкенд молча пропускал, движок игнорировал.
 *
 * Что осталось: намерения, которые в силе, — палитра ограничена каноническим
 * набором, данные меняет только backend-api, схема проверяется до сохранения.
 * Проверки формы графа больше не дублируются здесь: их делает контракт, и
 * `validateWorkflowSchema` теперь тонкая обёртка над ним.
 */

function node(overrides: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return {
    id: overrides.id,
    type: overrides.type ?? "wait-event",
    label: overrides.label ?? "Узел",
    config: overrides.config ?? {},
    position: overrides.position ?? { x: 0, y: 0 }
  };
}

function schema(nodes: WorkflowNode[], connections: WorkflowSchema["connections"] = []): WorkflowSchema {
  return { schema_version: WORKFLOW_SCHEMA_VERSION, kind: "workflow", nodes, connections };
}

describe("палитра узлов (ТЗ §13.13)", () => {
  it("предлагает канонические типы C5 и ничего сверх них", () => {
    const palette = workflowNodePalette("workflow").map((definition) => definition.type);

    expect(palette).toContain("wait-event");
    expect(palette).not.toContain("db_write");
    expect(palette.every((type) => FBP_NODE_TYPES.includes(type as never))).toBe(true);
  });

  it("не предлагает start/end в обычной схеме — они только для субсхем", () => {
    // Раньше палитра была плоским списком всех типов и звала добавить границы
    // субсхемы в Workflow, где контракт их отвергает.
    const workflow = workflowNodePalette("workflow").map((definition) => definition.type);
    const subschema = workflowNodePalette("subschema").map((definition) => definition.type);

    expect(workflow).not.toContain("start");
    expect(workflow).not.toContain("end");
    expect(subschema).toContain("start");
    expect(subschema).toContain("end");
  });

  it("не предлагает wait-event в субсхеме: событий там нет", () => {
    expect(workflowNodePalette("subschema").map((d) => d.type)).not.toContain("wait-event");
  });

  it("считает узел изменяющим данные только для вызова Backend API (ТЗ §13.5)", () => {
    const mutating = FBP_NODE_TYPES.filter((type) => workflowNodeMutatesData(type as never));
    expect(mutating).toEqual(["backend-api"]);
  });

  it("распознаёт безопасные типы и отвергает произвольные", () => {
    expect(isSafeWorkflowNodeType("transform")).toBe(true);
    expect(isSafeWorkflowNodeType("wait_event")).toBe(false);
    expect(isSafeWorkflowNodeType("db_write")).toBe(false);
  });
});

describe("createWorkflowSchema", () => {
  it("создаёт пустой граф с обязательными schema_version и kind", () => {
    // В 2.0 kind обязателен: от него зависят палитра и правила валидации.
    expect(createWorkflowSchema("workflow")).toEqual({
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [],
      connections: []
    });
  });
});

describe("createWorkflowNode / createWorkflowConnection", () => {
  it("создаёт узел с детерминированным id и пустым основным полем", () => {
    const created = createWorkflowNode("knowledge-base-search", []);
    const primary = workflowNodePrimaryField("knowledge-base-search");

    expect(created.id).toBe("node-knowledge-base-search-1");
    expect(created.type).toBe("knowledge-base-search");
    expect(created.config).toEqual({ [primary!.key]: "" });
    expect((created.label ?? "").trim().length).toBeGreaterThan(0);
  });

  it("гарантирует уникальность id при совпадении префикса", () => {
    const existing = [node({ id: "node-branch-1", type: "branch" })];
    const created = createWorkflowNode("branch", existing);

    expect(created.id).toBe("node-branch-2");
  });

  it("создаёт связь с ЗАДАННЫМИ портами: дефолтов out/in больше нет (D2)", () => {
    // Регрессия D2: раньше порты подставлялись константами `out`/`in`, потому что
    // в 1.0 они были у всех узлов. В 2.0 состав портов зависит от узла и графа —
    // угаданный порт контракт отвергает.
    const first = createWorkflowConnection("check", "false", "cold", "in", []);
    const second = createWorkflowConnection("check", "true", "hot", "in", [first]);

    expect(first).toEqual({ id: "conn-1", from: "check", fromPort: "false", to: "cold", toPort: "in" });
    expect(second.id).toBe("conn-2");
  });

  it("создаёт sub_schema как ссылку на slug", () => {
    const created = createWorkflowNode("sub_schema", []);

    expect(created.id).toBe("node-sub_schema-1");
    expect(created.config).toEqual({ subSchemaSlug: "" });
  });
});

describe("validateWorkflowSchema — обёртка над контрактом", () => {
  it("принимает корректную схему", () => {
    const valid = schema(
      [
        node({ id: "n1", type: "wait-event", label: "Событие", config: { event_type: "message.created" } }),
        node({
          id: "n2",
          type: "variable_write",
          label: "Запись",
          config: { name: "seen", inputs: [{ name: "value", type: "any" }] }
        })
      ],
      [{ id: "conn-1", from: "n1", fromPort: "out", to: "n2", toPort: "in" }]
    );

    expect(validateWorkflowSchema(valid).valid).toBe(true);
  });

  it("отвергает запрещённый тип узла и называет проблемный узел", () => {
    // nodeId в ответе обязателен: по нему холст подсвечивает, ГДЕ ошибка.
    const result = validateWorkflowSchema(
      schema([node({ id: "n1", type: "db_write", label: "Прямая запись" })])
    );

    expect(result.valid).toBe(false);
    expect(result.nodeIds).toContain("n1");
  });

  it("отвергает дублирующиеся идентификаторы узлов", () => {
    // Конфиг узлов валиден намеренно: контракт бросает на ПЕРВОЙ ошибке, и с
    // пустым config.event_type тест поймал бы её, а не дубликат.
    const event = { event_type: "message.created" };
    const result = validateWorkflowSchema(
      schema([node({ id: "dup", label: "A", config: event }), node({ id: "dup", label: "B", config: event })])
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/[Дд]убл/);
  });

  it("отвергает связь на несуществующий узел", () => {
    const result = validateWorkflowSchema(
      schema(
        [node({ id: "n1", label: "A", config: { event_type: "message.created" } })],
        [{ id: "conn-1", from: "n1", fromPort: "out", to: "ghost", toPort: "in" }]
      )
    );

    expect(result.valid).toBe(false);
  });

  it("отвергает схему с чужой версией", () => {
    const result = validateWorkflowSchema({
      ...schema([node({ id: "n1", label: "A" })]),
      schema_version: "1.0.0"
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("2.0.0");
  });
});
