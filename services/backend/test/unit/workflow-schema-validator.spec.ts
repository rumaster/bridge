import {
  validateWorkflowSchema,
  validateWorkflowSchemaShape,
  collectWorkflowSubSchemaSlugs,
} from "../../src/modules/workflow/workflow-schema.validator";

type Node = Record<string, unknown>;

function node(id: string, type: string, config: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, config };
}

const waitEvent = () => node("evt", "wait-event", { event_type: "message.created" });

function workflow(nodes: Node[], connections: Record<string, unknown>[] = []): Record<string, unknown> {
  return { schema_version: "2.0.0", kind: "workflow", nodes, connections };
}

/**
 * Ревизия 2026-07-15: Backend больше не содержит собственной реализации
 * валидации — он вызывает контракт C5 из `@bridge/contracts/c5-workflow`. Эти
 * тесты проверяют, что вызов действительно происходит и что ответ сохраняет
 * форму `{ valid, errors: [{ path, message }] }`, на которую опирается API.
 */
describe("workflow-schema.validator: делегирование контракту C5", () => {
  it("принимает корректную схему 2.0.0 с источником события", () => {
    const result = validateWorkflowSchema(
      workflow(
        [waitEvent(), node("w", "variable_write", { inputs: [{ name: "value", type: "object" }] })],
        [{ id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" }],
      ),
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("сохраняет узел ветвления с обеими ветками true/false (регрессия дефекта D1)", () => {
    // До ревизии Backend читал `connection.port` вместо `fromPort` и схлопывал все
    // исходящие связи узла в один ключ — из-за чего эта схема не сохранялась.
    const result = validateWorkflowSchema(
      workflow(
        [
          waitEvent(),
          node("b", "branch", { operator: "exists" }),
          node("w1", "variable_write"),
          node("w2", "variable_write"),
        ],
        [
          { id: "c1", from: "evt", fromPort: "out", to: "b", toPort: "in" },
          { id: "c2", from: "b", fromPort: "true", to: "w1", toPort: "in" },
          { id: "c3", from: "b", fromPort: "false", to: "w2", toPort: "in" },
        ],
      ),
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("отвергает схему без узла «Ожидание события» и указывает путь", () => {
    const result = validateWorkflowSchema(workflow([node("t", "transform", { code: "return 1;" })]));

    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe("$.nodes");
    expect(result.errors[0].message).toMatch(/Ожидание события/);
  });

  it("отвергает несовместимые порты и относит ошибку к связям", () => {
    const result = validateWorkflowSchema(
      workflow(
        [waitEvent(), node("kb", "knowledge-base-search")],
        [{ id: "c1", from: "evt", fromPort: "data", to: "kb", toPort: "keys" }],
      ),
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe("$.connections");
  });

  it("не даёт узлу backend-api подменить арендатора через config (§13.13-п.4)", () => {
    const result = validateWorkflowSchema(
      workflow(
        [waitEvent(), node("api", "backend-api", { operation_id: "x", organization_id: "spoofed" })],
        [{ id: "c1", from: "evt", fromPort: "out", to: "api", toPort: "in" }],
      ),
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/запрещённый ключ/);
  });

  it("отвергает не-объект", () => {
    expect(validateWorkflowSchema("nope").valid).toBe(false);
  });
});

describe("workflow-schema.validator: лимиты песочницы (уровень Backend)", () => {
  it("отвергает код transform длиннее предела", () => {
    const result = validateWorkflowSchema(
      workflow(
        [waitEvent(), node("t", "transform", { code: `return "${"x".repeat(50)}";` })],
        [],
      ),
      { limits: { maxCodeLength: 10 } },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === "$.nodes[1].config.code")).toBe(true);
  });
});

describe("workflow-schema.validator: форма драфта", () => {
  it("пропускает недостроенный драфт — автосохранение не должно его терять", () => {
    // У узла ещё не выбрано событие, связей нет: полная валидация это отвергнет,
    // но драфт обязан сохраниться, иначе выход из редактора потеряет работу.
    const draft = workflow([node("evt", "wait-event", {})]);

    expect(validateWorkflowSchemaShape(draft)).toEqual({ valid: true, errors: [] });
    expect(validateWorkflowSchema(draft).valid).toBe(false);
  });

  it("отвергает то, что вообще не является графом", () => {
    expect(validateWorkflowSchemaShape({ nodes: "нет" }).valid).toBe(false);
    expect(validateWorkflowSchemaShape(null).valid).toBe(false);
  });
});

describe("workflow-schema.validator: сбор ссылок на субсхемы", () => {
  it("собирает slug'и, включая транзитивные из инлайн-графа", () => {
    const schema = workflow([
      waitEvent(),
      node("s1", "sub_schema", {
        subSchemaSlug: "outer",
        graph: workflow([node("s2", "sub_schema", { subSchemaSlug: "inner" })]),
      }),
    ]);

    expect(collectWorkflowSubSchemaSlugs(schema)).toEqual(["inner", "outer"]);
  });

  it("возвращает пустой список для схемы без субсхем", () => {
    expect(collectWorkflowSubSchemaSlugs(workflow([waitEvent()]))).toEqual([]);
  });
});
