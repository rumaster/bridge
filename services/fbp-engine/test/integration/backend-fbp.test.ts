import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpEngine } from "../../src/engine.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const fixedNow = () => "2026-07-03T13:00:00.000Z";

/**
 * Операции выводятся из каталога предикатом, а не хардкодом: каталог
 * генерируется из OpenAPI и переезжает вместе с API.
 *
 * Для проверки изоляции арендаторов нужны GET и POST на ОДНОМ пути: мок Backend
 * хранит записи по пути, поэтому «B записал → A прочитал тот же путь» иначе не
 * выразить.
 */
function findMethodPair() {
  const byPath = new Map<string, Record<string, any>>();
  for (const op of BACKEND_API_OPERATIONS) {
    if (op.path_params.length > 0) continue;
    if (!byPath.has(op.path)) byPath.set(op.path, {});
    byPath.get(op.path)![op.method] = op;
  }
  const pair = [...byPath.values()].find((ops) => ops.GET && ops.POST);
  assert.ok(pair, "в каталоге нужны GET и POST на одном пути без плейсхолдеров");
  return pair as { GET: any; POST: any };
}

const { GET: GET_OP, POST: POST_OP } = findMethodPair();
const PATH_PARAM_OP = BACKEND_API_OPERATIONS.find((op) => op.method === "GET" && op.path_params.length === 1)!;

function makeEngine(mock: any, extra: Record<string, unknown> = {}) {
  return createFbpEngine({ backendClient: mock, now: fixedNow, limits: { codeTimeoutMs: 5000 }, ...extra });
}

function context(organizationId: string, actorUserId: string, trigger = "manual") {
  return { organization_id: organizationId, actor_user_id: actorUserId, trigger };
}

function events(journal: any[]) {
  return journal.map((entry) => entry.event);
}

const evtNode = { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } };

/** Событие → вызов Backend API: нагрузка события уходит в тело портом `body`. */
function callSchema(operationId: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    nodes: [
      evtNode,
      {
        id: "create",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: { operation_id: operationId, inputs: [{ name: "body", type: "object" }] },
      },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "create", toPort: "body" },
    ],
  };
}

describe("Интеграция Backend↔FBP: узел Backend API через мок", () => {
  it("CP-4: событие → узел Backend API → финал → журнал", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);

    const result = await engine.runWorkflow({
      schema: callSchema(POST_OP.operation_id),
      context: context(ORG_A, "user-a"),
      input: { title: "Заявка A" },
      startNodeId: "evt",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.organization_id, ORG_A);
    assert.equal(result.output.response.status_code, 201);
    assert.deepEqual(result.output.response.body.echo, { title: "Заявка A" });

    // Вызов Backend получил КОНТЕКСТ арендатора/актора из ExecutionContext.
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].organization_id, ORG_A);
    assert.equal(mock.received[0].actor_user_id, "user-a");
    assert.equal(mock.received[0].method, POST_OP.method);
    assert.equal(mock.received[0].path, POST_OP.path, "путь пришёл из каталога, а не из конфига узла");
    assert.equal(mock.writesFor(ORG_A).length, 1);

    // Журнал имеет форму workflow_execution_logs и полный жизненный цикл: узел
    // события теперь исполняется наравне с прочими, поэтому пар node.* — две.
    assert.deepEqual(events(result.journal), [
      "workflow.started",
      "node.started",
      "node.completed",
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

  it("передаёт данные между узлами по data-связям (transform → backend-api)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const schema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        evtNode,
        {
          id: "prepare",
          type: "transform",
          position: { x: 0, y: 0 },
          config: {
            code: "return { name: input.event.name, source: 'wf' };",
            inputs: [{ name: "event", type: "object" }],
            outputs: [{ name: "payload", type: "object" }],
          },
        },
        {
          id: "create",
          type: "backend-api",
          position: { x: 0, y: 0 },
          config: { operation_id: POST_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
        },
      ],
      connections: [
        { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
        { id: "c2", from: "evt", fromPort: "data", to: "prepare", toPort: "event" },
        { id: "c3", from: "prepare", fromPort: "payload", to: "create", toPort: "body" },
      ],
    };

    const result = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: { name: "Иван" },
      startNodeId: "evt",
    });

    assert.equal(result.status, "completed", JSON.stringify(result.error));
    assert.deepEqual(mock.received[0].body, { name: "Иван", source: "wf" });
    assert.equal(mock.received[0].organization_id, ORG_A);
  });

  it("разрешает sub_schema по slug при старте и берёт обновлённый граф из registry", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const registry = new Map<string, any>([["shared-normalize", subSchemaReturning("v1")]]);
    const engine = makeEngine(mock, { resolveSubSchema: ({ slug }: any) => registry.get(slug) });
    const schema: any = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        evtNode,
        {
          id: "reuse",
          type: "sub_schema",
          position: { x: 0, y: 0 },
          config: {
            subSchemaSlug: "shared-normalize",
            ports: { inputs: [{ id: "text", type: "string" }], outputs: [{ id: "result", type: "string" }] },
          },
        },
        {
          id: "pick",
          type: "transform",
          position: { x: 0, y: 0 },
          config: {
            code: "return input.event.text;",
            inputs: [{ name: "event", type: "object" }],
            outputs: [{ name: "text", type: "string" }],
          },
        },
      ],
      connections: [
        { id: "c1", from: "evt", fromPort: "out", to: "reuse", toPort: "in" },
        { id: "c2", from: "evt", fromPort: "data", to: "pick", toPort: "event" },
        { id: "c3", from: "pick", fromPort: "text", to: "reuse", toPort: "text" },
      ],
    };

    const first = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: { text: "запрос" },
      startNodeId: "evt",
    });
    // Субсхема резолвится ПРИ КАЖДОМ старте: обновлённый граф подхватывается без
    // правки вызывающей схемы — в ней лежит только slug.
    registry.set("shared-normalize", subSchemaReturning("v2"));
    const second = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: { text: "запрос" },
      startNodeId: "evt",
    });

    assert.equal(first.status, "completed", JSON.stringify(first.error));
    assert.equal(first.output.result, "v1:запрос");
    assert.equal(second.status, "completed", JSON.stringify(second.error));
    assert.equal(second.output.result, "v2:запрос");
    assert.deepEqual(schema.nodes[1].config.subSchemaSlug, "shared-normalize");
  });

  it("МУЛЬТИАРЕНДНОСТЬ: org A не видит данные org B (§13.13-п.4, §22.6)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    const writeSchema = callSchema(POST_OP.operation_id);
    const readSchema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        evtNode,
        { id: "read", type: "backend-api", position: { x: 0, y: 0 }, config: { operation_id: GET_OP.operation_id } },
      ],
      connections: [{ id: "c1", from: "evt", fromPort: "out", to: "read", toPort: "in" }],
    };

    // org B создаёт свою запись.
    await engine.runWorkflow({
      schema: writeSchema,
      context: context(ORG_B, "user-b"),
      input: { title: "Секрет B" },
      startNodeId: "evt",
    });

    // org A читает тот же путь — и НЕ ДОЛЖНА увидеть записи org B.
    const readA = await engine.runWorkflow({
      schema: readSchema,
      context: context(ORG_A, "user-a"),
      input: {},
      startNodeId: "evt",
    });
    assert.equal(readA.status, "completed");
    assert.deepEqual(readA.output.response.body.records, []);
    assert.equal(readA.output.response.body.organization_id, ORG_A);

    // org B читает и видит ТОЛЬКО свою запись.
    const readB = await engine.runWorkflow({
      schema: readSchema,
      context: context(ORG_B, "user-b"),
      input: {},
      startNodeId: "evt",
    });
    assert.equal(readB.output.response.body.records.length, 1);
    assert.equal(readB.output.response.body.records[0].body.title, "Секрет B");

    // Ни один вызов org A не унёс чужой organization_id.
    const orgAReceived = mock.received.filter((call: any) => call.actor_user_id === "user-a");
    assert.ok(orgAReceived.every((call: any) => call.organization_id === ORG_A));
    assert.notEqual(
      JSON.stringify(readA.output.response.body.records),
      JSON.stringify(readB.output.response.body.records),
    );
  });

  it("ошибка узла фиксируется в журнале и возвращается как failed (журнал сохраняется)", async () => {
    const mock = createTenantBackendApiMock({ now: fixedNow });
    const engine = makeEngine(mock);
    // Плейсхолдер пути объявлен портом (иначе схема не сохранилась бы), но ничем
    // не запитан — значение не придёт, и узел обязан упасть ДО вызова Backend.
    const schema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        evtNode,
        {
          id: "get",
          type: "backend-api",
          position: { x: 0, y: 0 },
          config: {
            operation_id: PATH_PARAM_OP.operation_id,
            inputs: PATH_PARAM_OP.path_params.map((name: string) => ({ name, type: "string" })),
          },
        },
      ],
      connections: [{ id: "c1", from: "evt", fromPort: "out", to: "get", toPort: "in" }],
    };

    const result = await engine.runWorkflow({
      schema,
      context: context(ORG_A, "user-a"),
      input: {},
      startNodeId: "evt",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error.reason, "invalid_path_parameter");
    assert.equal(result.error.node_id, "get");
    assert.ok(events(result.journal).includes("node.failed"));
    assert.ok(events(result.journal).includes("workflow.failed"));
    assert.equal(mock.received.length, 0, "запрос к Backend не отправлен при ошибке подстановки пути");
  });
});

/** Субсхема: принимает text через start, возвращает `${prefix}:${text}` через end. */
function subSchemaReturning(prefix: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "subschema",
    nodes: [
      { id: "s", type: "start", position: { x: 0, y: 0 }, config: { outputs: [{ id: "text", label: "Текст", type: "string" }] } },
      {
        id: "format",
        type: "transform",
        position: { x: 0, y: 0 },
        config: {
          code: `return ${JSON.stringify(`${prefix}:`)} + input.text;`,
          inputs: [{ name: "text", type: "string" }],
          outputs: [{ name: "value", type: "string" }],
        },
      },
      { id: "e", type: "end", position: { x: 0, y: 0 }, config: { inputs: [{ id: "result", label: "Результат", type: "string" }] } },
    ],
    connections: [
      { id: "c1", from: "s", fromPort: "out", to: "e", toPort: "in" },
      { id: "c2", from: "s", fromPort: "text", to: "format", toPort: "text" },
      { id: "c3", from: "format", fromPort: "value", to: "e", toPort: "result" },
    ],
  };
}
