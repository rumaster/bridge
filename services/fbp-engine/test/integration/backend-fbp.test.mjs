import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../src/backend/client.mjs";
import { createFbpEngine } from "../../src/engine.mjs";

const ORG_A = "org-a";
const ORG_B = "org-b";
const fixedNow = () => "2026-07-03T13:00:00.000Z";

function makeEngine(mock) {
  return createFbpEngine({ backendClient: mock, now: fixedNow });
}

function context(organizationId, actorUserId, trigger = "manual") {
  return { organization_id: organizationId, actor_user_id: actorUserId, trigger };
}

function events(journal) {
  return journal.map((entry) => entry.event);
}

describe("Интеграция Backend↔FBP: узел Backend API через мок", () => {
  it("CP-4: старт → узел Backend API → финал → журнал", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const schema = {
      schema_version: "1.0.0",
      entry: "create",
      nodes: [
        {
          id: "create",
          type: "backend-api",
          input: { title: { kind: "params", path: ["title"] } },
          config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
        },
      ],
      connections: [],
    };

    const result = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: { title: "Заявка A" },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.organization_id, ORG_A);
    assert.equal(result.output.status_code, 201);
    assert.deepEqual(result.output.body.echo, { title: "Заявка A" });

    // Вызов Backend получил КОНТЕКСТ арендатора/актора из ExecutionContext.
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].organization_id, ORG_A);
    assert.equal(mock.received[0].actor_user_id, "user-a");
    assert.equal(mock.writesFor(ORG_A).length, 1);

    // Журнал имеет форму workflow_execution_logs и полный жизненный цикл.
    assert.deepEqual(events(result.journal), [
      "workflow.started",
      "node.started",
      "node.completed",
      "workflow.completed",
    ]);
    for (const entry of result.journal) {
      assert.equal(entry.organization_id, ORG_A);
      assert.equal(entry.instance_id, result.instance_id);
      assert.equal(entry.created_at, fixedNow());
    }
  });

  it("передаёт данные между узлами (transform → backend-api)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const schema = {
      schema_version: "1.0.0",
      entry: "prepare",
      nodes: [
        {
          id: "prepare",
          type: "transform",
          input: { name: { kind: "params", path: ["name"] } },
          config: { expression: { op: "merge", args: [{ op: "input" }, { op: "lit", value: { source: "wf" } }] } },
        },
        {
          id: "create",
          type: "backend-api",
          input: { payload: { kind: "node", node: "prepare", path: [] } },
          config: { method: "POST", path: "/api/v1/records", body: { op: "get", object: { op: "input" }, path: ["payload"] } },
        },
      ],
      connections: [{ from: "prepare", to: "create" }],
    };

    const result = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: { name: "Иван" },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(mock.received[0].body, { name: "Иван", source: "wf" });
    assert.equal(mock.received[0].organization_id, ORG_A);
  });

  it("МУЛЬТИАРЕНДНОСТЬ: org A не видит данные org B (§13.13-п.4, §22.6)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);

    const writeSchema = {
      schema_version: "1.0.0",
      entry: "create",
      nodes: [
        {
          id: "create",
          type: "backend-api",
          input: { title: { kind: "params", path: ["title"] } },
          config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
        },
      ],
      connections: [],
    };
    const readSchema = {
      schema_version: "1.0.0",
      entry: "read",
      nodes: [{ id: "read", type: "backend-api", config: { method: "GET", path: "/api/v1/records" } }],
      connections: [],
    };

    // org B создаёт свою запись.
    await engine.runWorkflow({ schema: writeSchema, context: context(ORG_B, "user-b"), input: { title: "Секрет B" } });

    // org A читает тот же путь — и НЕ ДОЛЖНА увидеть записи org B.
    const readA = await engine.runWorkflow({ schema: readSchema, context: context(ORG_A, "user-a"), input: {} });
    assert.equal(readA.status, "completed");
    assert.deepEqual(readA.output.body.records, []);
    assert.equal(readA.output.body.organization_id, ORG_A);

    // org B читает и видит ТОЛЬКО свою запись.
    const readB = await engine.runWorkflow({ schema: readSchema, context: context(ORG_B, "user-b"), input: {} });
    assert.equal(readB.output.body.records.length, 1);
    assert.equal(readB.output.body.records[0].body.title, "Секрет B");

    // Ни один вызов org A не унёс чужой organization_id.
    const orgAReceived = mock.received.filter((call) => call.actor_user_id === "user-a");
    assert.ok(orgAReceived.every((call) => call.organization_id === ORG_A));
    assert.notEqual(JSON.stringify(readA.output.body.records), JSON.stringify(readB.output.body.records));
  });

  it("узел wait-event переводит экземпляр в состояние ожидания и не идёт дальше", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const schema = {
      schema_version: "1.0.0",
      entry: "wait",
      nodes: [
        { id: "wait", type: "wait-event", config: { event_type: "payment.confirmed" } },
        { id: "after", type: "transform", config: { expression: { op: "lit", value: "done" } } },
      ],
      connections: [{ from: "wait", to: "after" }],
    };

    const result = await engine.runWorkflow({ schema, context: context(ORG_A, "user-a"), input: { order: 1 } });

    assert.equal(result.status, "waiting");
    assert.equal(result.wait.event_type, "payment.confirmed");
    assert.equal(result.waitingNodeId, "wait");
    assert.ok(events(result.journal).includes("workflow.waiting"));
    assert.ok(!result.journal.some((entry) => entry.node_id === "after"), "узел after не должен исполняться");
  });

  it("ошибка узла фиксируется в журнале и возвращается как failed (журнал сохраняется)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const schema = {
      schema_version: "1.0.0",
      entry: "get",
      nodes: [{ id: "get", type: "backend-api", config: { method: "GET", path: "/api/v1/records/{id}" } }],
      connections: [],
    };

    const result = await engine.runWorkflow({ schema, context: context(ORG_A, "user-a"), input: {} });

    assert.equal(result.status, "failed");
    assert.equal(result.error.reason, "invalid_path_parameter");
    assert.equal(result.error.node_id, "get");
    assert.ok(events(result.journal).includes("node.failed"));
    assert.ok(events(result.journal).includes("workflow.failed"));
    assert.equal(mock.received.length, 0, "запрос к Backend не отправлен при ошибке подстановки пути");
  });
});
