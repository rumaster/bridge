import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.js";
import { createFbpEngine } from "../../services/fbp-engine/src/engine.js";

/**
 * e2e на РЕАЛЬНОМ движке FBP (форк, M3-10). Демонстрирует два контрольных
 * сценария вехи M3 без Docker/БД: исполнение через доменно-нейтральное ядро и
 * узел Backend API как единственный способ менять данные.
 *
 * Замороженный wire-контракт C5 (детерминированный C5-сервер) не затрагивается —
 * это отдельный аддитивный сценарий на прикладном фасаде движка.
 *
 * Ревизия 2026-07-15: схемы переведены на 2.0. Точка входа — узел «Ожидание
 * события» (`startNodeId`), `entry` упразднён; `transform` стал pure-узлом без
 * exec-портов и вычисляется по требованию; проверки whitelist Transform-выражений
 * удалены вместе с режимом `expression` (решение A8).
 */

const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b2";
const fixedNow = () => "2026-07-03T13:00:00.000Z";

// Операции берём из каталога предикатом: он генерируется из OpenAPI и едет за API.
const CREATE_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;
const OTHER_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body && op.operation_id !== CREATE_OP.operation_id,
)!;

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

const eventNode = {
  id: "evt",
  type: "wait-event",
  position: { x: 0, y: 0 },
  config: { event_type: "message.created" },
};

describe("CP-4: Workflow вызывает Backend API (старт → узел → финал → журнал)", () => {
  it("исполняет граф transform → backend-api → branch и фиксирует полный журнал", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = createFbpEngine({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 } });

    const schema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      workflow_id: "wf-orders",
      workflow_version_id: "wf-orders-v1",
      nodes: [
        eventNode,
        {
          id: "prepare",
          type: "transform",
          position: { x: 0, y: 0 },
          config: {
            code: 'return { title: input.event.title, amount: input.event.amount, source: "workflow" };',
            inputs: [{ name: "event", type: "object" }],
            outputs: [{ name: "body", type: "object", path: "result" }],
          },
        },
        {
          id: "create",
          type: "backend-api",
          position: { x: 0, y: 0 },
          config: {
            operation_id: CREATE_OP.operation_id,
            inputs: [{ name: "body", type: "object" }],
            outputs: [{ name: "status_code", type: "number" }],
          },
        },
        {
          id: "check",
          type: "branch",
          position: { x: 0, y: 0 },
          config: { operator: "gte", right: 200 },
        },
      ],
      connections: [
        { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
        { id: "c2", from: "create", fromPort: "out", to: "check", toPort: "in" },
        { id: "c3", from: "evt", fromPort: "data", to: "prepare", toPort: "event" },
        { id: "c4", from: "prepare", fromPort: "body", to: "create", toPort: "body" },
        { id: "c5", from: "create", fromPort: "status_code", to: "check", toPort: "value" },
      ],
    };

    const result = await engine.runWorkflow({
      schema,
      context: { organization_id: ORG_A, actor_user_id: "manager-a", trigger: "manual" },
      input: { title: "Заказ №1", amount: 500 },
      startNodeId: "evt",
    });

    // Финал: workflow завершён успешно, ветвление ушло в порт true (201 >= 200).
    assert.equal(result.status, "completed");
    assert.equal(result.organization_id, ORG_A);

    // Узел Backend API — единственный, кто обратился к Backend, с контекстом арендатора.
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].method, CREATE_OP.method);
    assert.equal(mock.received[0].path, CREATE_OP.path, "путь пришёл из каталога, а не из конфига узла");
    assert.equal(mock.received[0].organization_id, ORG_A);
    assert.equal(mock.received[0].actor_user_id, "manager-a");
    assert.deepEqual(mock.received[0].body, { title: "Заказ №1", amount: 500, source: "workflow" });
    assert.equal(mock.writesFor(ORG_A).length, 1);

    // Журнал: старт → по узлу на каждый шаг → финал. `prepare` — pure-узел: он
    // попадает в журнал не по exec-потоку, а в тот момент, когда `create` вытянул
    // его выход, — то есть ПЕРЕД началом самого `create`.
    const eventsSeq = result.journal.map((row) => `${row.event}${row.node_id ? `(${row.node_id})` : ""}`);
    assert.deepEqual(eventsSeq, [
      "workflow.started",
      "node.started(evt)", "node.completed(evt)",
      "node.started(prepare)", "node.completed(prepare)",
      "node.started(create)", "node.completed(create)",
      "node.started(check)", "node.completed(check)",
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
    const engine = createFbpEngine({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
    const schema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        eventNode,
        {
          id: "create",
          type: "backend-api",
          position: { x: 0, y: 0 },
          config: { operation_id: CREATE_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
        },
      ],
      connections: [
        { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
        { id: "c2", from: "evt", fromPort: "data", to: "create", toPort: "body" },
      ],
    };

    await engine.runWorkflow({
      schema,
      context: { organization_id: ORG_A, actor_user_id: "a", trigger: "manual" },
      input: { title: "A" },
      startNodeId: "evt",
    });
    await engine.runWorkflow({
      schema,
      context: { organization_id: ORG_B, actor_user_id: "b", trigger: "manual" },
      input: { title: "B" },
      startNodeId: "evt",
    });

    assert.equal(mock.writesFor(ORG_A).length, 1);
    assert.equal(mock.writesFor(ORG_B).length, 1);
    assert.equal(mock.writesFor(ORG_A)[0].body.title, "A");
    assert.equal(mock.writesFor(ORG_B)[0].body.title, "B");
    // Ни одна запись не «протекла» между организациями.
    assert.ok(mock.writesFor(ORG_A).every((w) => w.body.title !== "B"));
    // Каждый вызов ушёл строго от имени своего арендатора (§13.5).
    assert.ok(mock.received.every((call) => call.organization_id === (call.body.title === "A" ? ORG_A : ORG_B)));
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

  function baseSchema(operationId = CREATE_OP.operation_id): any {
    return {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        { ...eventNode },
        {
          id: "start",
          type: "transform",
          position: { x: 0, y: 0 },
          config: {
            code: "return input.event;",
            inputs: [{ name: "event", type: "object" }],
            outputs: [{ name: "body", type: "object", path: "result" }],
          },
        },
        {
          id: "call",
          type: "backend-api",
          position: { x: 0, y: 0 },
          config: { operation_id: operationId, inputs: [{ name: "body", type: "object" }] },
        },
      ],
      connections: [
        { id: "c1", from: "evt", fromPort: "out", to: "call", toPort: "in" },
        { id: "c2", from: "evt", fromPort: "data", to: "start", toPort: "event" },
        { id: "c3", from: "start", fromPort: "body", to: "call", toPort: "body" },
      ],
    };
  }

  it("сохраняет корректную схему как версию 1, а корректную правку — как версию 2", () => {
    const engine = createFbpEngine({ backendClient: { call: async () => ({}) } });
    const store = createVersionStore(engine);

    const first = store.save("wf-admin", baseSchema());
    assert.equal(first.saved, true, JSON.stringify(first.errors));
    assert.equal(first.version.version_no, 1);

    const second = store.save("wf-admin", baseSchema(OTHER_OP.operation_id));
    assert.equal(second.saved, true, JSON.stringify(second.errors));
    assert.equal(second.version.version_no, 2, "монотонный version_no (§13.10)");
    assert.equal(second.version.schema.nodes[2].config.operation_id, OTHER_OP.operation_id);
    assert.equal(store.versions.length, 2);
  });

  it("ОТВЕРГАЕТ некорректную правку и НЕ создаёт новую версию (§13.13-п.5)", () => {
    const engine = createFbpEngine({
      backendClient: { call: async () => ({}) },
      limits: { maxCodeLength: 256 },
    });
    const store = createVersionStore(engine);
    store.save("wf-admin", baseSchema());
    assert.equal(store.versions.length, 1);

    // Правка с попыткой подмены арендатора в узле Backend API.
    const withSpoof = baseSchema();
    withSpoof.nodes[2].config.organization_id = "org-foreign";
    const rejectedSpoof = store.save("wf-admin", withSpoof);
    assert.equal(rejectedSpoof.saved, false);
    assert.ok(rejectedSpoof.errors.some((e) => /organization_id/.test(e.message)));

    // Правка с вызовом вне каталога: произвольный путь задать нельзя (решение A3).
    const offCatalog = baseSchema();
    offCatalog.nodes[2].config.operation_id = "NoSuchOperationInCatalog";
    assert.equal(store.save("wf-admin", offCatalog).saved, false);

    // Правка, вводящая цикл (нарушение DAG).
    const withCycle = baseSchema();
    withCycle.nodes.push({
      id: "after",
      type: "variable_write",
      position: { x: 0, y: 0 },
      config: { inputs: [{ name: "v", type: "any" }] },
    });
    withCycle.connections.push({ id: "c4", from: "call", fromPort: "out", to: "after", toPort: "in" });
    withCycle.connections.push({ id: "c5", from: "after", fromPort: "out", to: "call", toPort: "in" });
    assert.equal(store.save("wf-admin", withCycle).saved, false);

    // Правка с кодом сверх лимита песочницы: ловится на сохранении, а не на запуске.
    const oversized = baseSchema();
    oversized.nodes[1].config.code = `return ${JSON.stringify("x".repeat(512))};`;
    const rejectedCode = store.save("wf-admin", oversized);
    assert.equal(rejectedCode.saved, false);
    assert.ok(rejectedCode.errors.some((e) => e.path.endsWith(".code")));

    // Ни одна отклонённая правка не создала версию.
    assert.equal(store.versions.length, 1);
  });
});
