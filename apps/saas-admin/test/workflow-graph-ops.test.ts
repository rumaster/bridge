import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import type { WorkflowSchema } from "@bridge/contracts/c5-workflow";
import { describe, expect, it } from "vitest";

import {
  GraphOperationError,
  canConnectGraphPorts,
  connectGraphPorts,
  dataInputPortIds,
  portSignature,
  removeGraphNodes,
  waitEventNodes,
} from "../src/presentation/workflow/graph-ops";

/**
 * Операции над графом — чистые функции, поэтому проверяются без рендера.
 *
 * Главное здесь — дефект D2: редактор жёстко ставил порты `out`/`in` и собирал
 * связи, которые контракт отвергал. Теперь порты приходят с холста, а правила
 * знает контракт.
 */

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function graph(nodes: ReturnType<typeof node>[], connections: WorkflowSchema["connections"] = []): WorkflowSchema {
  return { schema_version: WORKFLOW_SCHEMA_VERSION, kind: "workflow", nodes, connections };
}

const waitNode = () => node("wait", "wait-event", { event_type: "message.created" });

describe("connectGraphPorts", () => {
  it("соединяет exec-порты и заводит связь с ИМЕНАМИ портов, а не с out/in", () => {
    // Регрессия D2: раньше порты подставлялись константами, и связь ссылалась на
    // порты, которых у узла нет.
    const before = graph([waitNode(), node("w", "variable_write", { name: "v", inputs: [] })]);

    const after = connectGraphPorts(before, {
      source: "wait",
      sourceHandle: "out",
      target: "w",
      targetHandle: "in",
    });

    expect(after.connections).toHaveLength(1);
    expect(after.connections[0]).toMatchObject({ from: "wait", fromPort: "out", to: "w", toPort: "in" });
  });

  it("соединяет ветку false узла branch — то, что через API было нельзя (D1/D2)", () => {
    const before = graph([
      waitNode(),
      node("check", "branch", { operator: "truthy" }),
      node("hot", "variable_write", { name: "r", inputs: [] }),
      node("cold", "variable_write", { name: "r", inputs: [] }),
    ]);

    const withTrue = connectGraphPorts(before, {
      source: "check",
      sourceHandle: "true",
      target: "hot",
      targetHandle: "in",
    });
    const withBoth = connectGraphPorts(withTrue, {
      source: "check",
      sourceHandle: "false",
      target: "cold",
      targetHandle: "in",
    });

    expect(withBoth.connections.map((c) => c.fromPort).sort()).toEqual(["false", "true"]);
  });

  it("отвергает несовместимые типы портов с причиной", () => {
    const before = graph([
      waitNode(),
      node("t", "transform", { code: "return 1;", outputs: [{ name: "num", type: "number" }] }),
      node("w", "variable_write", { name: "v", inputs: [{ name: "text", type: "string" }] }),
    ]);

    expect(() =>
      connectGraphPorts(before, { source: "t", sourceHandle: "num", target: "w", targetHandle: "text" }),
    ).toThrow(GraphOperationError);
  });

  it("отвергает соединение узла с самим собой", () => {
    const before = graph([waitNode()]);

    expect(() =>
      connectGraphPorts(before, { source: "wait", sourceHandle: "out", target: "wait", targetHandle: "in" }),
    ).toThrow(GraphOperationError);
  });

  it("новое ребро на data-вход ЗАМЕЩАЕТ старое: на data-вход заводится ровно одно", () => {
    // Иначе перетаскивание связи давало бы невалидный граф вместо замены.
    const before = graph(
      [
        waitNode(),
        node("a", "transform", { code: "return 'a';", outputs: [{ name: "value", type: "string" }] }),
        node("b", "transform", { code: "return 'b';", outputs: [{ name: "value", type: "string" }] }),
        node("w", "variable_write", { name: "v", inputs: [{ name: "text", type: "string" }] }),
      ],
      [{ id: "c1", from: "a", fromPort: "value", to: "w", toPort: "text" }],
    );

    const after = connectGraphPorts(before, {
      source: "b",
      sourceHandle: "value",
      target: "w",
      targetHandle: "text",
    });

    const toText = after.connections.filter((c) => c.to === "w" && c.toPort === "text");
    expect(toText).toHaveLength(1);
    expect(toText[0].from).toBe("b");
  });

  it("на exec-вход замещения нет: сходящиеся потоки — это смысл merge", () => {
    // Входы merge называются in_1, in_2, … и растут по мере подключения.
    const before = graph(
      [
        waitNode(),
        node("second", "wait-event", { event_type: "message.status_changed" }),
        node("m", "merge", {}),
      ],
      [{ id: "c1", from: "wait", fromPort: "out", to: "m", toPort: "in_1" }],
    );

    const after = connectGraphPorts(before, {
      source: "second",
      sourceHandle: "out",
      target: "m",
      targetHandle: "in_2",
    });

    expect(after.connections.filter((c) => c.to === "m")).toHaveLength(2);
  });

  it("подсветка при перетаскивании совпадает с результатом отпускания", () => {
    // Обе стороны — одна функция: иначе занятый data-вход подсвечивался бы
    // запрещённым, а connectGraphPorts его бы принял.
    const before = graph(
      [
        waitNode(),
        node("a", "transform", { code: "return 'a';", outputs: [{ name: "value", type: "string" }] }),
        node("b", "transform", { code: "return 'b';", outputs: [{ name: "value", type: "string" }] }),
        node("w", "variable_write", { name: "v", inputs: [{ name: "text", type: "string" }] }),
      ],
      [{ id: "c1", from: "a", fromPort: "value", to: "w", toPort: "text" }],
    );
    const attempt = { source: "b", sourceHandle: "value", target: "w", targetHandle: "text" };

    expect(canConnectGraphPorts(before, attempt).valid).toBe(true);
    expect(() => connectGraphPorts(before, attempt)).not.toThrow();
  });

  it("несовместимость видна и подсветке, и соединению", () => {
    const before = graph([
      waitNode(),
      node("t", "transform", { code: "return 1;", outputs: [{ name: "num", type: "number" }] }),
      node("w", "variable_write", { name: "v", inputs: [{ name: "text", type: "string" }] }),
    ]);
    const attempt = { source: "t", sourceHandle: "num", target: "w", targetHandle: "text" };

    expect(canConnectGraphPorts(before, attempt).valid).toBe(false);
    expect(() => connectGraphPorts(before, attempt)).toThrow(GraphOperationError);
  });
});

describe("removeGraphNodes", () => {
  it("удаляет узел вместе с его рёбрами", () => {
    // Связь на несуществующий узел контракт отвергает — оставить её значит
    // сломать схему молча.
    const before = graph(
      [waitNode(), node("w", "variable_write", { name: "v", inputs: [] })],
      [{ id: "c1", from: "wait", fromPort: "out", to: "w", toPort: "in" }],
    );

    const after = removeGraphNodes(before, ["w"]);

    expect(after.nodes.map((n) => n.id)).toEqual(["wait"]);
    expect(after.connections).toEqual([]);
  });
});

describe("portSignature", () => {
  it("меняется при правке портов — по ней холст перерегистрирует хэндлы", () => {
    // Без этого xyflow не замечает смену состава портов, если габариты узла те же.
    const before = node("t", "transform", { code: "return 1;", outputs: [{ name: "a", type: "string" }] });
    const after = node("t", "transform", { code: "return 1;", outputs: [{ name: "b", type: "string" }] });
    const schema = graph([before]);

    expect(portSignature(schema, before)).not.toBe(portSignature(schema, after));
  });

  it("не меняется при перемещении узла", () => {
    const before = node("t", "transform", { code: "return 1;", outputs: [{ name: "a", type: "string" }] });
    const moved = { ...before, position: { x: 500, y: 500 } };
    const schema = graph([before]);

    expect(portSignature(schema, before)).toBe(portSignature(schema, moved));
  });
});

describe("dataInputPortIds", () => {
  it("отдаёт только data-входы: exec в промпт не подставишь", () => {
    const target = node("w", "variable_write", {
      name: "v",
      inputs: [{ name: "text", type: "string" }],
    });

    expect(dataInputPortIds(graph([target]), target)).toEqual(["text"]);
  });
});

describe("waitEventNodes", () => {
  it("находит точки входа схемы 2.0 — из них выбирается старт тест-прогона", () => {
    const schema = graph([waitNode(), node("t", "transform", { code: "return 1;" })]);

    expect(waitEventNodes(schema).map((n) => n.id)).toEqual(["wait"]);
  });
});
