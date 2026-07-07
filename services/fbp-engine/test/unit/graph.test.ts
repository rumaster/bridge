import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGraph, findCycle } from "../../src/core/graph.js";

describe("Модель графа: маршрутизация переходов", () => {
  const schema = {
    entry: "a",
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    connections: [
      { from: "a", fromPort: "out", to: "b", toPort: "in" },
      { from: "b", fromPort: "true", to: "c", toPort: "in" },
      { from: "b", fromPort: "false", to: "a", toPort: "in" },
    ],
  };

  it("next() возвращает следующий узел по выходному порту", () => {
    const graph = buildGraph(schema);
    assert.equal(graph.entry, "a");
    assert.equal(graph.next("a"), "b");
    assert.equal(graph.next("a", "out"), "b");
    assert.equal(graph.next("b", "true"), "c");
    assert.equal(graph.next("b", "false"), "a");
  });

  it("next() возвращает null для несуществующего порта или узла-стока", () => {
    const graph = buildGraph(schema);
    assert.equal(graph.next("b", "missing"), null);
    assert.equal(graph.next("c"), null);
    assert.equal(graph.next("unknown"), null);
  });

  it("getNode() отдаёт узел или null", () => {
    const graph = buildGraph(schema);
    assert.deepEqual(graph.getNode("a"), { id: "a" });
    assert.equal(graph.getNode("zzz"), null);
  });
});

describe("Модель графа: обнаружение циклов (DAG-инвариант)", () => {
  it("возвращает null для ациклического графа", () => {
    const cycle = findCycle({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      connections: [
        { from: "a", fromPort: "out", to: "b", toPort: "in" },
        { from: "b", fromPort: "out", to: "c", toPort: "in" },
      ],
    });
    assert.equal(cycle, null);
  });

  it("находит цикл и перечисляет его узлы", () => {
    const cycle = findCycle({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      connections: [
        { from: "a", fromPort: "out", to: "b", toPort: "in" },
        { from: "b", fromPort: "out", to: "c", toPort: "in" },
        { from: "c", fromPort: "out", to: "a", toPort: "in" },
      ],
    });
    assert.ok(Array.isArray(cycle));
    assert.ok(cycle.includes("a") && cycle.includes("b") && cycle.includes("c"));
  });

  it("находит петлю на себя", () => {
    const cycle = findCycle({
      nodes: [{ id: "a" }],
      connections: [{ from: "a", fromPort: "out", to: "a", toPort: "in" }],
    });
    assert.ok(Array.isArray(cycle));
    assert.ok(cycle.includes("a"));
  });
});
