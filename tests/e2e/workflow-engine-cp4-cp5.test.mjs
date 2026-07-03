import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.mjs";
import { createFbpEngine } from "../../services/fbp-engine/src/engine.mjs";

/**
 * e2e на РЕАЛЬНОМ движке FBP (форк, M3-10). Демонстрирует два контрольных
 * сценария вехи M3 без Docker/БД: исполнение через доменно-нейтральное ядро и
 * узел Backend API как единственный способ менять данные.
 *
 * Замороженный wire-контракт C5 (детерминированный C5-сервер) не затрагивается —
 * это отдельный аддитивный сценарий на прикладном фасаде движка.
 */

const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b2";
const fixedNow = () => "2026-07-03T13:00:00.000Z";

// Столбцы workflow_execution_logs (M3-01): движок возвращает журнал именно этой
// формы, но сам в БД не пишет (§13.13-п.3).
const JOURNAL_COLUMNS = ["id", "organization_id", "instance_id", "node_id", "event", "data", "created_at"];

function assertJournalRowIsInsertable(row, organizationId, instanceId) {
  assert.deepEqual(Object.keys(row).sort(), [...JOURNAL_COLUMNS].sort());
  assert.equal(row.organization_id, organizationId);
  assert.equal(row.instance_id, instanceId);
  // CHECK-ограничения таблицы: event не пустой; node_id либо null, либо не пустой; data — объект.
  assert.ok(typeof row.event === "string" && row.event.trim() !== "", "event не пустой");
  assert.ok(row.node_id === null || (typeof row.node_id === "string" && row.node_id.trim() !== ""));
  assert.ok(row.data !== null && typeof row.data === "object" && !Array.isArray(row.data), "data — объект");
  assert.match(row.id, /^[0-9a-f-]{36}$/);
}

describe("CP-4: Workflow вызывает Backend API (старт → узел → финал → журнал)", () => {
  it("исполняет граф transform → backend-api → branch и фиксирует полный журнал", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = createFbpEngine({ backendClient: mock, now: fixedNow });

    const schema = {
      schema_version: "1.0.0",
      workflow_id: "wf-orders",
      workflow_version_id: "wf-orders-v1",
      entry: "prepare",
      nodes: [
        {
          id: "prepare",
          type: "transform",
          input: { title: { kind: "params", path: ["title"] }, amount: { kind: "params", path: ["amount"] } },
          config: {
            expression: {
              op: "merge",
              args: [{ op: "input" }, { op: "lit", value: { source: "workflow" } }],
            },
          },
        },
        {
          id: "create",
          type: "backend-api",
          input: { payload: { kind: "node", node: "prepare", path: [] } },
          config: {
            method: "POST",
            path: "/api/v1/orders",
            body: { op: "get", object: { op: "input" }, path: ["payload"] },
          },
        },
        {
          id: "check",
          type: "branch",
          input: { code: { kind: "node", node: "create", path: ["status_code"] } },
          config: {
            condition: { op: "gte", args: [{ op: "get", object: { op: "input" }, path: ["code"] }, { op: "lit", value: 200 }] },
          },
        },
      ],
      connections: [
        { from: "prepare", to: "create" },
        { from: "create", to: "check" },
      ],
    };

    const result = await engine.runWorkflow({
      schema,
      context: { organization_id: ORG_A, actor_user_id: "manager-a", trigger: "manual" },
      input: { title: "Заказ №1", amount: 500 },
    });

    // Финал: workflow завершён успешно, ветвление ушло в порт true (201 >= 200).
    assert.equal(result.status, "completed");
    assert.equal(result.organization_id, ORG_A);

    // Узел Backend API — единственный, кто обратился к Backend, с контекстом арендатора.
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].method, "POST");
    assert.equal(mock.received[0].path, "/api/v1/orders");
    assert.equal(mock.received[0].organization_id, ORG_A);
    assert.equal(mock.received[0].actor_user_id, "manager-a");
    assert.deepEqual(mock.received[0].body, { title: "Заказ №1", amount: 500, source: "workflow" });
    assert.equal(mock.writesFor(ORG_A).length, 1);

    // Журнал: старт → по узлу на каждый шаг → финал; ветвление зафиксировало порт.
    const eventsSeq = result.journal.map((row) => row.event);
    assert.deepEqual(eventsSeq, [
      "workflow.started",
      "node.started", "node.completed", // prepare
      "node.started", "node.completed", // create
      "node.started", "node.completed", // check
      "workflow.completed",
    ]);
    const branchRow = result.journal.find((row) => row.node_id === "check" && row.event === "node.completed");
    assert.equal(branchRow.data.port, "true");

    // Каждая запись журнала пригодна для вставки в workflow_execution_logs.
    for (const row of result.journal) {
      assertJournalRowIsInsertable(row, ORG_A, result.instance_id);
    }
  });

  it("мультиарендность: тот же Workflow для org A и org B не смешивает данные", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = createFbpEngine({ backendClient: mock, now: fixedNow });
    const schema = {
      schema_version: "1.0.0",
      entry: "create",
      nodes: [
        {
          id: "create",
          type: "backend-api",
          input: { title: { kind: "params", path: ["title"] } },
          config: { method: "POST", path: "/api/v1/orders", body: { op: "input" } },
        },
      ],
      connections: [],
    };

    await engine.runWorkflow({ schema, context: { organization_id: ORG_A, actor_user_id: "a", trigger: "manual" }, input: { title: "A" } });
    await engine.runWorkflow({ schema, context: { organization_id: ORG_B, actor_user_id: "b", trigger: "manual" }, input: { title: "B" } });

    assert.equal(mock.writesFor(ORG_A).length, 1);
    assert.equal(mock.writesFor(ORG_B).length, 1);
    assert.equal(mock.writesFor(ORG_A)[0].body.title, "A");
    assert.equal(mock.writesFor(ORG_B)[0].body.title, "B");
    // Ни одна запись не «протекла» между организациями.
    assert.ok(mock.writesFor(ORG_A).every((w) => w.body.title !== "B"));
  });
});

describe("CP-5: Admin правит Workflow (валидация + сохранение новой версии, §16.7)", () => {
  // In-memory модель редактора SVC-ADMIN + таблицы workflow_versions:
  // сохранение новой версии = валидация схемы движком + вставка с version_no+1.
  // Движок НЕ пишет в БД — он лишь валидирует (§13.13-п.3/§13.13-п.5).
  function createVersionStore(engine) {
    const versions = [];
    return {
      versions,
      save(workflowId, schema) {
        const validation = engine.validateSchema(schema);
        if (!validation.valid) {
          return { saved: false, errors: validation.errors };
        }
        const last = versions.filter((v) => v.workflow_id === workflowId).at(-1);
        const version = { workflow_id: workflowId, version_no: (last?.version_no ?? 0) + 1, schema };
        versions.push(version);
        return { saved: true, version };
      },
    };
  }

  function baseSchema(pathSuffix = "records") {
    return {
      schema_version: "1.0.0",
      entry: "start",
      nodes: [
        { id: "start", type: "transform", config: { expression: { op: "input" } } },
        {
          id: "call",
          type: "backend-api",
          input: { data: { kind: "node", node: "start", path: [] } },
          config: { method: "POST", path: `/api/v1/${pathSuffix}`, body: { op: "input" } },
        },
      ],
      connections: [{ from: "start", to: "call" }],
    };
  }

  it("сохраняет корректную схему как версию 1, а корректную правку — как версию 2", () => {
    const engine = createFbpEngine({ backendClient: { call: async () => ({}) } });
    const store = createVersionStore(engine);

    const first = store.save("wf-admin", baseSchema("records"));
    assert.equal(first.saved, true);
    assert.equal(first.version.version_no, 1);

    const second = store.save("wf-admin", baseSchema("tickets"));
    assert.equal(second.saved, true);
    assert.equal(second.version.version_no, 2, "монотонный version_no (§13.10)");
    assert.equal(second.version.schema.nodes[1].config.path, "/api/v1/tickets");
    assert.equal(store.versions.length, 2);
  });

  it("ОТВЕРГАЕТ некорректную правку и НЕ создаёт новую версию (§13.13-п.5)", () => {
    const engine = createFbpEngine({ backendClient: { call: async () => ({}) } });
    const store = createVersionStore(engine);
    store.save("wf-admin", baseSchema());
    assert.equal(store.versions.length, 1);

    // Правка с операцией Transform вне whitelist.
    const withEval = baseSchema();
    withEval.nodes[0].config.expression = { op: "eval", args: [{ op: "lit", value: "code" }] };
    const rejectedEval = store.save("wf-admin", withEval);
    assert.equal(rejectedEval.saved, false);
    assert.ok(rejectedEval.errors.some((e) => e.path.includes(".expression")));

    // Правка с попыткой подмены арендатора в узле Backend API.
    const withSpoof = baseSchema();
    withSpoof.nodes[1].config.organization_id = "org-foreign";
    const rejectedSpoof = store.save("wf-admin", withSpoof);
    assert.equal(rejectedSpoof.saved, false);
    assert.ok(rejectedSpoof.errors.some((e) => e.path.endsWith(".organization_id")));

    // Правка, вводящая цикл (нарушение DAG).
    const withCycle = baseSchema();
    withCycle.connections.push({ from: "call", to: "start" });
    const rejectedCycle = store.save("wf-admin", withCycle);
    assert.equal(rejectedCycle.saved, false);

    // Ни одна отклонённая правка не создала версию.
    assert.equal(store.versions.length, 1);
  });
});
