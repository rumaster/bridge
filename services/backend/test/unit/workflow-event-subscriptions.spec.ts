import {
  WORKFLOW_EVENT_DEFINITIONS,
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_PLANNED_EVENT_TYPES,
  getWorkflowEventDefinition,
  isWorkflowEventType,
  workflowEventUnavailableReason,
} from "@bridge/contracts/workflow-events";

import {
  BACKEND_API_OPERATIONS,
  getBackendApiOperation,
  isBackendApiOperationId,
} from "@bridge/contracts/backend-api-catalog";

import {
  collectBackendApiOperationIds,
  collectWaitEventNodes,
} from "../../src/modules/workflow/workflow-schema.validator";

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function workflow(nodes: unknown[]) {
  return { schema_version: "2.0.0", kind: "workflow", nodes, connections: [] };
}

describe("реестр событий Workflow", () => {
  it("содержит только события, которые кто-то действительно публикует", () => {
    // Публикуются ровно два (c7-realtime-event.publisher.ts). Остальные типы из
    // C7_EVENT_TYPES объявлены, но не эмитятся — подписка на них не сработала бы.
    expect([...WORKFLOW_EVENT_TYPES]).toEqual(["message.created", "message.status_changed"]);
  });

  it("не пересекает доступные и запланированные типы", () => {
    const overlap = WORKFLOW_PLANNED_EVENT_TYPES.filter((type) => WORKFLOW_EVENT_TYPES.includes(type));
    expect(overlap).toEqual([]);
  });

  it("у каждого события есть образец нагрузки для предзаполнения теста", () => {
    for (const definition of WORKFLOW_EVENT_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.payload_schema).toBeTruthy();
      expect(Object.keys(definition.sample_payload).length).toBeGreaterThan(0);
      expect(definition.correlation_fields.length).toBeGreaterThan(0);
    }
  });

  it("объясняет, почему запланированное событие недоступно", () => {
    expect(isWorkflowEventType("message.created")).toBe(true);
    expect(isWorkflowEventType("typing.started")).toBe(false);
    expect(workflowEventUnavailableReason("message.created")).toBeNull();
    expect(workflowEventUnavailableReason("typing.started")).toMatch(/не публикуется/);
    expect(workflowEventUnavailableReason("выдумка")).toMatch(/Неизвестный тип/);
  });

  it("образец нагрузки согласован со схемой: обязательные поля присутствуют", () => {
    for (const definition of WORKFLOW_EVENT_DEFINITIONS) {
      const required = (definition.payload_schema as { required?: string[] }).required ?? [];
      for (const field of required) {
        expect(Object.hasOwn(definition.sample_payload, field)).toBe(true);
      }
    }
  });

  it("резолвит определение по типу", () => {
    expect(getWorkflowEventDefinition("message.created")?.label).toBe("Получено сообщение");
    expect(getWorkflowEventDefinition("нет такого")).toBeNull();
  });
});

describe("сбор узлов «Ожидание события» для подписок", () => {
  it("находит все узлы-источники с типом события и корреляцией", () => {
    const schema = workflow([
      node("e1", "wait-event", { event_type: "message.created", correlation: { conversation_id: "c-1" } }),
      node("e2", "wait-event", { event_type: "message.status_changed" }),
      node("t", "transform", { code: "return 1;" }),
    ]);

    expect(collectWaitEventNodes(schema)).toEqual([
      { nodeId: "e1", eventType: "message.created", correlation: { conversation_id: "c-1" } },
      { nodeId: "e2", eventType: "message.status_changed", correlation: {} },
    ]);
  });

  it("пропускает узлы без выбранного события — подписывать не на что", () => {
    expect(collectWaitEventNodes(workflow([node("e", "wait-event", {})]))).toEqual([]);
    expect(collectWaitEventNodes(workflow([node("e", "wait-event", { event_type: "   " })]))).toEqual([]);
  });

  it("устойчив к мусору вместо схемы", () => {
    expect(collectWaitEventNodes(null)).toEqual([]);
    expect(collectWaitEventNodes({ nodes: "нет" })).toEqual([]);
    expect(collectWaitEventNodes(workflow([]))).toEqual([]);
  });
});

describe("каталог вызовов Backend API", () => {
  it("сгенерирован из OpenAPI и не пуст", () => {
    expect(BACKEND_API_OPERATIONS.length).toBeGreaterThan(50);
  });

  it("все пути лежат под публичным /api/v1", () => {
    // Узел backend-api ходит только в публичный API (ТЗ §13.5) — если в каталог
    // просочился внутренний маршрут, это дыра, а не удобство.
    const outside = BACKEND_API_OPERATIONS.filter((op) => !op.path.startsWith("/api/v1"));
    expect(outside).toEqual([]);
  });

  it("operation_id уникальны — иначе выбор в редакторе неоднозначен", () => {
    const ids = BACKEND_API_OPERATIONS.map((op) => op.operation_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("плейсхолдеры пути разобраны в path_params", () => {
    const withParams = BACKEND_API_OPERATIONS.find((op) => op.path.includes("{"));
    expect(withParams).toBeTruthy();
    expect(withParams!.path_params.length).toBeGreaterThan(0);
    for (const name of withParams!.path_params) {
      expect(withParams!.path).toContain(`{${name}}`);
    }
  });

  it("резолвит операцию по id", () => {
    const first = BACKEND_API_OPERATIONS[0];
    expect(isBackendApiOperationId(first.operation_id)).toBe(true);
    expect(getBackendApiOperation(first.operation_id)?.path).toBe(first.path);
    expect(isBackendApiOperationId("выдумка")).toBe(false);
    expect(getBackendApiOperation("выдумка")).toBeNull();
  });
});

describe("сбор вызовов Backend API для проверки витрины", () => {
  it("собирает operation_id, включая инлайн-граф субсхемы", () => {
    const schema = {
      schema_version: "2.0.0",
      kind: "workflow",
      connections: [],
      nodes: [
        node("a", "backend-api", { operation_id: "opB" }),
        node("s", "sub_schema", {
          subSchemaSlug: "x",
          graph: { nodes: [node("b", "backend-api", { operation_id: "opA" })] },
        }),
      ],
    };
    expect(collectBackendApiOperationIds(schema)).toEqual(["opA", "opB"]);
  });

  it("не собирает узлы без выбранного вызова", () => {
    const schema = { schema_version: "2.0.0", kind: "workflow", connections: [], nodes: [node("a", "backend-api", {})] };
    expect(collectBackendApiOperationIds(schema)).toEqual([]);
    expect(collectBackendApiOperationIds(null)).toEqual([]);
  });
});
