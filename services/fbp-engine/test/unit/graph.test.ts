import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGraph } from "../../src/core/graph.js";

function node(id: string, type: string) {
  return { id, type, position: { x: 0, y: 0 }, config: {} };
}

function link(id: string, from: string, fromPort: string, to: string, toPort: string) {
  return { id, from, fromPort, to, toPort };
}

/**
 * Ревизия 2026-07-15: связи разделены на exec и data, `next()` и `findCycle()`
 * удалены (циклы теперь ловит контракт C5 на сохранении схемы). Топология обязана
 * вмещать то, чего прежняя карта `Map<from, Map<port, to>>` вместить не могла:
 * несколько целей на одном exec-выходе.
 */
describe("Модель графа: классификация связей на exec и data", () => {
  const schema = {
    nodes: [node("evt", "wait-event"), node("t", "transform"), node("w", "variable_write")],
    connections: [
      link("c1", "evt", "out", "w", "in"),
      link("c2", "evt", "data", "t", "src"),
      link("c3", "t", "value", "w", "v"),
    ],
  };

  it("exec-связи попадают только в execConnectionsFrom, data-связи — только в dataConnectionsTo", () => {
    const graph = buildGraph(schema);

    assert.deepEqual(
      graph.execConnectionsFrom("evt").map((c: any) => c.id),
      ["c1"],
      "порт data узла события — не exec, несмотря на общий узел-источник",
    );
    assert.deepEqual(graph.execConnectionsFrom("t"), [], "transform — pure-узел, exec-связей не имеет");
    assert.deepEqual(
      graph.dataConnectionsTo("w").map((c: any) => c.id),
      ["c3"],
      "exec-связь c1 в data-входы попасть не должна",
    );
    assert.deepEqual(graph.dataConnectionsTo("t").map((c: any) => c.id), ["c2"]);
  });

  it("узел без связей отдаёт пустые списки, а не undefined", () => {
    const graph = buildGraph({ nodes: [node("lonely", "merge")], connections: [] });
    assert.deepEqual(graph.execConnectionsFrom("lonely"), []);
    assert.deepEqual(graph.dataConnectionsTo("lonely"), []);
    assert.deepEqual(graph.execConnectionsFrom("несуществующий"), []);
  });

  it("getNode() отдаёт узел или null", () => {
    const graph = buildGraph(schema);
    assert.equal(graph.getNode("t")?.type, "transform");
    assert.equal(graph.getNode("zzz"), null);
  });
});

describe("Модель графа: один exec-выход ведёт в несколько узлов", () => {
  it("execConnectionsFrom отдаёт ВСЕ цели порта — так стартуют параллельные потоки", () => {
    const graph = buildGraph({
      nodes: [node("evt", "wait-event"), node("a", "variable_write"), node("b", "variable_write")],
      connections: [link("c1", "evt", "out", "a", "in"), link("c2", "evt", "out", "b", "in")],
    });
    assert.deepEqual(
      graph.execConnectionsFrom("evt").map((c: any) => c.to),
      ["a", "b"],
    );
  });

  it("выходы branch различимы по fromPort: обе ветки лежат в одном списке", () => {
    const graph = buildGraph({
      nodes: [node("b", "branch"), node("yes", "merge"), node("no", "merge")],
      connections: [link("c1", "b", "true", "yes", "in_1"), link("c2", "b", "false", "no", "in_1")],
    });
    const byPort = Object.fromEntries(graph.execConnectionsFrom("b").map((c: any) => [c.fromPort, c.to]));
    assert.deepEqual(byPort, { true: "yes", false: "no" });
  });
});

describe("Модель графа: incomingExecCount — размер барьера merge", () => {
  const schema = {
    nodes: [
      node("evt", "wait-event"),
      node("a", "variable_write"),
      node("b", "variable_write"),
      node("m", "merge"),
      node("t", "transform"),
    ],
    connections: [
      link("c1", "evt", "out", "a", "in"),
      link("c2", "evt", "out", "b", "in"),
      link("c3", "a", "out", "m", "in_1"),
      link("c4", "b", "out", "m", "in_2"),
      // Data-ребро в тот же узел барьер увеличивать не должно.
      link("c5", "t", "value", "m", "hint"),
    ],
  };

  it("считает сходящиеся exec-потоки и игнорирует data-рёбра", () => {
    const graph = buildGraph(schema);
    assert.equal(graph.incomingExecCount("m"), 2);
    assert.equal(graph.incomingExecCount("a"), 1);
    assert.equal(graph.incomingExecCount("evt"), 0, "узел-источник exec-входов не имеет");
  });

  it("динамические входы merge in_1..in_N считаются как exec", () => {
    const graph = buildGraph({
      nodes: [node("m", "merge"), node("x", "variable_write"), node("y", "variable_write"), node("z", "variable_write")],
      connections: [
        link("c1", "x", "out", "m", "in_1"),
        link("c2", "y", "out", "m", "in_2"),
        link("c3", "z", "out", "m", "in_3"),
      ],
    });
    assert.equal(graph.incomingExecCount("m"), 3);
  });
});
