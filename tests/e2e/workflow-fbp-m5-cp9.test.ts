import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.js";
import { WorkflowStoreError } from "../../services/fbp-engine/src/core/errors.js";
import {
  createFbpRuntime,
  createWorkflowMetrics,
  renderWorkflowMetrics,
} from "../../services/fbp-engine/src/engine.js";

/**
 * e2e вехи M5-10 (SVC-FBP), участие в регрессионном наборе ТЗ §26.6 (CP-9). Один
 * сквозной сценарий сводит результаты M5 на РЕАЛЬНОМ рантайме движка без Docker/БД:
 *
 *  1. НАГРУЗКА/МАСШТАБИРОВАНИЕ (§25.3, §25.11): N экземпляров двух арендаторов
 *     через кластер stateless-узлов.
 *  2. ХАРДЕНИНГ Transform Node (§13.4): контракт C5 отвергает опасный конфиг на
 *     ВАЛИДАЦИИ, произвольный JS исполняется в песочнице без Node-глобалей.
 *  3. ПОЛНОТА ЖУРНАЛА / метрики Workflow (§13.9, §24.6): запуски, успехи, ошибки,
 *     активные экземпляры, отдача в формате Prometheus.
 *
 * Ревизия 2026-07-15: фазы «старт → ожидание → продолжение» больше нет —
 * исполнение сквозное, `resume` удалён. Проверки whitelist Transform-выражений
 * удалены вместе с режимом `expression` (решение A8): у узла остался только JS,
 * и его держит песочница, а не список разрешённых операций.
 */

const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b2";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;

const evtNode = { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } };

/**
 * Схема нагрузочной части: событие → вызов Backend API. Узел transform здесь
 * сознательно не используется — он исполняется в отдельном процессе-песочнице, и
 * на N экземплярах сценарий мерил бы стоимость спавна процессов, а не
 * масштабирование исполнителей. Песочница проверяется отдельным тестом ниже.
 */
function orderSchema() {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-orders",
    nodes: [
      evtNode,
      {
        id: "create",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: { operation_id: POST_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
      },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "create", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "create", toPort: "body" },
    ],
  };
}

/** Схема с произвольным JS: результат наблюдаем в трассе (variable_write данных не отдаёт). */
function codeSchema(workflowId: string, code: string) {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: workflowId,
    nodes: [
      evtNode,
      {
        id: "code",
        type: "transform",
        position: { x: 0, y: 0 },
        config: { code, inputs: [{ name: "event", type: "object" }], outputs: [{ name: "value", type: "any" }] },
      },
      { id: "w", type: "variable_write", position: { x: 0, y: 0 }, config: { inputs: [{ name: "payload", type: "any" }] } },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "code", toPort: "event" },
      { id: "c3", from: "code", fromPort: "value", to: "w", toPort: "payload" },
    ],
  };
}

function ctx(org: string, actor: string) {
  return { organization_id: org, actor_user_id: actor, trigger: "manual" };
}

// Кластер из K stateless-узлов поверх общих реестра версий, хранилища экземпляров и
// коллектора метрик (в бою — Backend по C3, §25.3).
function makeCluster({ nodeCount = 3 } = {}) {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const metrics = createWorkflowMetrics();
  const seed = createFbpRuntime({ backendClient: mock, metrics, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
  const nodes = Array.from({ length: nodeCount }, () =>
    createFbpRuntime({
      backendClient: mock,
      versions: seed.versions,
      instances: seed.instances,
      metrics,
      now: fixedNow,
      limits: { codeTimeoutMs: 5000 },
    }),
  );
  return { mock, seed, nodes, metrics };
}

describe("M5-10 e2e (CP-9): нагрузка + харденинг + полнота журнала SVC-FBP", () => {
  it("нагрузка на кластере: N экземпляров двух арендаторов проходят через разные узлы, метрики §24.6 полны", async () => {
    const N = 12; // по 6 на арендатора
    const { mock, seed, nodes, metrics } = makeCluster({ nodeCount: 3 });
    seed.publishVersion({ organizationId: ORG_A, workflowId: "wf-orders", schema: orderSchema() });
    seed.publishVersion({ organizationId: ORG_B, workflowId: "wf-orders", schema: orderSchema() });

    for (let i = 0; i < N; i += 1) {
      const org = i % 2 === 0 ? ORG_A : ORG_B;
      const title = `Заказ №${i}`;
      const done = await nodes[i % nodes.length].start({
        organizationId: org,
        workflowId: "wf-orders",
        context: ctx(org, `manager-${i}`),
        input: { title },
        startNodeId: "evt",
      });
      assert.equal(done.status, "completed");
      assert.equal(done.organization_id, org, "экземпляр завершён строго в своём арендаторе");
      assert.equal(done.output.response.body.echo.title, title);
    }

    // Полнота журнала / метрики §24.6.
    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, N);
    assert.equal(snap.total.successes, N);
    assert.equal(snap.total.errors, 0);
    assert.equal(snap.total.active, 0);
    // Изоляция арендаторов сохранена под нагрузкой: у каждого ровно свои записи.
    assert.equal(mock.writesFor(ORG_A).length, N / 2);
    assert.equal(mock.writesFor(ORG_B).length, N / 2);
    assert.ok(mock.received.every((call: any) => call.organization_id === ORG_A || call.organization_id === ORG_B));

    // /metrics отдаётся в формате Prometheus и содержит ряды по Workflow.
    const text = renderWorkflowMetrics(snap);
    assert.match(text, /fbp_engine_workflow_runs_total 12/);
    assert.match(text, /fbp_engine_workflow_successes_total 12/);
  });

  it("харденинг: опасный конфиг узла отвергается на ВАЛИДАЦИИ схемы, а не при исполнении (§13.4, §13.13)", () => {
    const { seed } = makeCluster({ nodeCount: 1 });

    // Подмена арендатора в конфиге узла Backend API (§13.13-п.4).
    const spoof = orderSchema();
    (spoof.nodes[1].config as any).organization_id = ORG_B;
    assert.throws(
      () => seed.publishVersion({ organizationId: ORG_A, workflowId: "wf-spoof", schema: spoof }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_schema",
      "узел не может подменить арендатора — версия не публикуется",
    );

    // Вызов вне каталога Backend API: произвольный путь задать нельзя (решение A3).
    const offCatalog = orderSchema();
    (offCatalog.nodes[1].config as any).operation_id = "НетТакойОперации";
    assert.throws(
      () => seed.publishVersion({ organizationId: ORG_A, workflowId: "wf-off-catalog", schema: offCatalog }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_schema",
    );

    // Код сверх лимита песочницы (§13.13-п.5): ловится на сохранении, а не на первом запуске.
    // Лимит именно дефолтный (65536): `createFbpRuntime({ limits })` до валидации
    // при публикации НЕ доходит — см. отчёт, баг проводки лимитов в реестр версий.
    assert.throws(
      () =>
        seed.publishVersion({
          organizationId: ORG_A,
          workflowId: "wf-huge-code",
          schema: codeSchema("wf-huge-code", `return ${JSON.stringify("x".repeat(70000))};`),
        }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_schema",
    );
  });

  it("харденинг Transform Node: произвольный JS исполняется в sandbox с runtime-блокировками (§13.4)", async () => {
    const { seed } = makeCluster({ nodeCount: 1 });
    seed.publishVersion({
      organizationId: ORG_A,
      workflowId: "wf-transform-code",
      schema: codeSchema(
        "wf-transform-code",
        "const doubled = input.event.amount * 2; return { doubled, processType: typeof process };",
      ),
    });

    const ok = await seed.start({
      organizationId: ORG_A,
      workflowId: "wf-transform-code",
      context: ctx(ORG_A, "operator"),
      input: { amount: 21 },
      startNodeId: "evt",
    });
    assert.equal(ok.status, "completed");
    // Node-глобалей в песочнице нет: код видит только свой input.
    assert.deepEqual(ok.trace.find((entry: any) => entry.nodeId === "code").outputs, {
      value: { doubled: 42, processType: "undefined" },
    });

    seed.publishVersion({
      organizationId: ORG_A,
      workflowId: "wf-transform-code-attack",
      schema: codeSchema("wf-transform-code-attack", 'return globalThis.constructor.constructor("return process")();'),
    });

    const failed = await seed.start({
      organizationId: ORG_A,
      workflowId: "wf-transform-code-attack",
      context: ctx(ORG_A, "operator"),
      input: {},
      startNodeId: "evt",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.reason, "code_execution_failed");
    assert.equal(failed.error.node_id, "code");
    assert.match(failed.error.message, /Code generation from strings disallowed|process is not defined/);
  });

  it("деградация Backend не блокирует ядро: провал фиксируется в журнале, движок продолжает работу (§5.4, §13.2)", async () => {
    let backendUp = false;
    const healthy = createTenantBackendApiMock({ now: fixedNow });
    const flaky = {
      async call(args: any) {
        if (!backendUp) {
          const error = new Error("Backend недоступен.");
          (error as any).reason = "backend_unavailable";
          throw error;
        }
        return healthy.call(args);
      },
    };
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: flaky, metrics, now: fixedNow });
    runtime.publishVersion({ organizationId: ORG_A, workflowId: "wf-orders", schema: orderSchema() });

    // Backend недоступен → экземпляр падает штатно в failed с журналом.
    const failed = await runtime.start({
      organizationId: ORG_A,
      workflowId: "wf-orders",
      context: ctx(ORG_A, "m"),
      input: { title: "Заказ" },
      startNodeId: "evt",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.reason, "backend_unavailable");
    assert.ok(failed.journal.map((e: any) => e.event).includes("workflow.failed"));

    // Backend восстановился → НОВЫЙ экземпляр проходит до конца тем же движком.
    backendUp = true;
    const okDone = await runtime.start({
      organizationId: ORG_A,
      workflowId: "wf-orders",
      context: ctx(ORG_A, "m"),
      input: { title: "Заказ-2" },
      startNodeId: "evt",
    });
    assert.equal(okDone.status, "completed");

    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, 2);
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 1);
    assert.equal(snap.total.active, 0);
  });
});
