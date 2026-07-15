import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../services/fbp-engine/src/backend/client.js";
import {
  createFbpRuntime,
  createWorkflowMetrics,
  renderWorkflowMetrics,
} from "../../services/fbp-engine/src/engine.js";

/**
 * e2e вехи M5-10 (SVC-FBP), участие в регрессионном наборе ТЗ §26.6 (CP-9). Один
 * сквозной сценарий сводит три результата M5 на РЕАЛЬНОМ рантайме движка без
 * Docker/БД:
 *
 *  1. НАГРУЗКА/МАСШТАБИРОВАНИЕ (§25.3, §25.11): N экземпляров через кластер
 *     stateless-узлов, старт и продолжение на разных узлах.
 *  2. ХАРДЕНИНГ Transform Node (§13.4): попытки выхода из «песочницы» отвергаются
 *     на этапе ВАЛИДАЦИИ схемы, а не при исполнении.
 *  3. ПОЛНОТА ЖУРНАЛА / метрики Workflow (§13.9, §24.6): запуски, успехи, ошибки,
 *     среднее время, активные экземпляры.
 */

const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b2";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

function approvalSchema() {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-orders",
    entry: "prepare",
    nodes: [
      {
        id: "prepare",
        type: "transform",
        input: { title: { kind: "params", path: ["title"] } },
        config: { expression: { op: "merge", args: [{ op: "input" }, { op: "lit", value: { source: "wf" } }] } },
      },
      { id: "await_approval", type: "wait-event", config: { event_type: "order.approved" } },
      {
        id: "create",
        type: "backend-api",
        input: {
          title: { kind: "node", node: "prepare", path: ["title"] },
          decision: { kind: "node", node: "await_approval", path: ["decision"] },
        },
        config: { method: "POST", path: "/api/v1/orders", body: { op: "input" } },
      },
    ],
    connections: [
      { from: "prepare", fromPort: "out", to: "await_approval", toPort: "in" },
      { from: "await_approval", fromPort: "out", to: "create", toPort: "in" },
    ],
  };
}

function ctx(org, actor) {
  return { organization_id: org, actor_user_id: actor, trigger: "manual" };
}

// Кластер из K stateless-узлов поверх общих реестра версий, хранилища состояния и
// коллектора метрик (в бою — Backend по C3, §25.3).
function makeCluster({ nodeCount = 3 } = {}) {
  const mock = createTenantBackendApiMock({ now: fixedNow });
  const metrics = createWorkflowMetrics();
  const seed = createFbpRuntime({ backendClient: mock, metrics, now: fixedNow });
  const nodes = Array.from({ length: nodeCount }, () =>
    createFbpRuntime({ backendClient: mock, versions: seed.versions, instances: seed.instances, metrics, now: fixedNow }),
  );
  return { mock, seed, nodes, metrics };
}

describe("M5-10 e2e (CP-9): нагрузка + харденинг + полнота журнала SVC-FBP", () => {
  it("нагрузка на кластере: N экземпляров двух арендаторов проходят через разные узлы, метрики §24.6 полны", async () => {
    const N = 12; // по 6 на арендатора
    const { mock, seed, nodes, metrics } = makeCluster({ nodeCount: 3 });
    seed.publishVersion({ organizationId: ORG_A, workflowId: "wf-orders", schema: approvalSchema() });
    seed.publishVersion({ organizationId: ORG_B, workflowId: "wf-orders", schema: approvalSchema() });

    const handles = [];
    for (let i = 0; i < N; i += 1) {
      const org = i % 2 === 0 ? ORG_A : ORG_B;
      const started = await nodes[i % nodes.length].start({
        organizationId: org,
        workflowId: "wf-orders",
        context: ctx(org, `manager-${i}`),
        input: { title: `Заказ №${i}` },
      });
      assert.equal(started.status, "waiting");
      handles.push({ org, id: started.instance_id, title: `Заказ №${i}` });
    }

    // Все стартовали → все активны (waiting не терминален, §24.6).
    assert.equal(metrics.snapshot().total.active, N);

    // Продолжаем на ДРУГИХ узлах (перебалансировка нагрузки, §25.3).
    for (let i = 0; i < handles.length; i += 1) {
      const h = handles[i];
      const done = await nodes[(i + 1) % nodes.length].resume({ organizationId: h.org, instanceId: h.id, event: { decision: "approve" } });
      assert.equal(done.status, "completed");
      assert.equal(done.organization_id, h.org, "экземпляр завершён строго в своём арендаторе");
      assert.equal(done.output.body.echo.title, h.title);
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
    assert.ok(mock.received.every((call) => call.organization_id === ORG_A || call.organization_id === ORG_B));

    // /metrics отдаётся в формате Prometheus и содержит ряды по арендатору-нейтральному Workflow.
    const text = renderWorkflowMetrics(snap);
    assert.match(text, /fbp_engine_workflow_runs_total 12/);
    assert.match(text, /fbp_engine_workflow_successes_total 12/);
  });

  it("харденинг Transform Node: попытки выхода из песочницы отвергаются на ВАЛИДАЦИИ (§13.4)", () => {
    // Явно вредоносные выражения: доступ к процессу/среде/сети/ФС/коду/времени/ГСЧ.
    const attacks = [
      { op: "eval", args: [{ op: "lit", value: "process.exit(1)" }] },
      { op: "require", args: [{ op: "lit", value: "fs" }] },
      { op: "constructor", args: [{ op: "input" }] }, // унаследованный ключ Object.prototype
      { op: "toString", args: [{ op: "input" }] }, // унаследованный метод
      { op: "process", args: [] },
      { op: "readFile", args: [{ op: "lit", value: "/etc/passwd" }] },
      { op: "fetch", args: [{ op: "lit", value: "http://evil" }] },
      { op: "now", args: [] },
      { op: "random", args: [] },
    ];
    for (const attack of attacks) {
      const result = validateTransformExpression(attack);
      assert.equal(result.valid, false, `Атака ${JSON.stringify(attack.op)} должна быть отклонена валидацией`);
      assert.ok(result.errors.some((e) => /Недопустимая операция/.test(e.message)));
    }

    // При этом легитимные декларативные выражения проходят валидацию.
    const legit = { op: "merge", args: [{ op: "input" }, { op: "lit", value: { ok: true } }] };
    assert.equal(validateTransformExpression(legit).valid, true);
  });

  it("харденинг Transform Node code: произвольный JS исполняется в sandbox с runtime-блокировками (§13.4)", async () => {
    const { seed } = makeCluster({ nodeCount: 1 });
    seed.publishVersion({
      organizationId: ORG_A,
      workflowId: "wf-transform-code",
      schema: {
        schema_version: "1.0.0",
        workflow_id: "wf-transform-code",
        entry: "code",
        nodes: [
          {
            id: "code",
            type: "transform",
            input: { amount: { kind: "params", path: ["amount"] } },
            config: {
              mode: "code",
              code: "const doubled = input.amount * 2; return { doubled, processType: typeof process };",
            },
          },
        ],
        connections: [],
      },
    });

    const ok = await seed.start({
      organizationId: ORG_A,
      workflowId: "wf-transform-code",
      context: ctx(ORG_A, "operator"),
      input: { amount: 21 },
    });
    assert.equal(ok.status, "completed");
    assert.deepEqual(ok.output, { doubled: 42, processType: "undefined" });

    seed.publishVersion({
      organizationId: ORG_A,
      workflowId: "wf-transform-code-attack",
      schema: {
        schema_version: "1.0.0",
        workflow_id: "wf-transform-code-attack",
        entry: "attack",
        nodes: [
          {
            id: "attack",
            type: "transform",
            config: {
              mode: "code",
              code: 'return globalThis.constructor.constructor("return process")();',
            },
          },
        ],
        connections: [],
      },
    });

    const failed = await seed.start({
      organizationId: ORG_A,
      workflowId: "wf-transform-code-attack",
      context: ctx(ORG_A, "operator"),
      input: {},
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.reason, "code_execution_failed");
    assert.match(failed.error.message, /Code generation from strings disallowed|process is not defined/);
  });

  it("деградация Backend не блокирует ядро: провал фиксируется в журнале, движок продолжает работу (§5.4, §13.2)", async () => {
    let backendUp = false;
    const healthy = createTenantBackendApiMock({ now: fixedNow });
    const flaky = {
      async call(args) {
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
    runtime.publishVersion({ organizationId: ORG_A, workflowId: "wf-orders", schema: approvalSchema() });

    // Экземпляр стартует и уходит в ожидание (transform+wait не требуют Backend).
    const started = await runtime.start({ organizationId: ORG_A, workflowId: "wf-orders", context: ctx(ORG_A, "m"), input: { title: "Заказ" } });
    assert.equal(started.status, "waiting");

    // Backend недоступен → продолжение падает штатно в failed с журналом.
    const failed = await runtime.resume({ organizationId: ORG_A, instanceId: started.instance_id, event: { decision: "approve" } });
    assert.equal(failed.status, "failed");
    assert.ok(failed.journal.map((e) => e.event).includes("workflow.failed"));

    // Backend восстановился → НОВЫЙ экземпляр проходит до конца тем же движком.
    backendUp = true;
    const ok = await runtime.start({ organizationId: ORG_A, workflowId: "wf-orders", context: ctx(ORG_A, "m"), input: { title: "Заказ-2" } });
    const okDone = await runtime.resume({ organizationId: ORG_A, instanceId: ok.instance_id, event: { decision: "approve" } });
    assert.equal(okDone.status, "completed");

    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, 2);
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 1);
    assert.equal(snap.total.active, 0);
  });
});
