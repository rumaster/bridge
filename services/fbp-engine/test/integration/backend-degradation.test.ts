import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime, createWorkflowMetrics } from "../../src/engine.js";

const ORG = "org-degrade";
const fixedNow = () => "2026-07-04T00:00:00.000Z";
const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;

/**
 * Backend, который «недоступен»: любой вызов C3 падает. Моделирует деградацию
 * Backend/сети (ТЗ §5.4, §13.2). Движок обязан деградировать штатно — не блокировать
 * Коммуникационное ядро: экземпляр с узлом Backend API падает в `failed` с журналом,
 * а сам движок остаётся пригодным для дальнейших запусков.
 */
function createUnavailableBackend() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async call() {
      calls += 1;
      const error = new Error("Backend недоступен (соединение отклонено).");
      (error as any).reason = "backend_unavailable";
      throw error;
    },
  };
}

const evtNode = { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } };

/** Схема, которой Backend необходим: событие → вызов Backend API. */
function backendSchema() {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-backend",
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

/** Схема, которой Backend не нужен вовсе: событие → чистое вычисление → переменная. */
function transformOnlySchema() {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-transform",
    nodes: [
      evtNode,
      {
        id: "compute",
        type: "transform",
        position: { x: 0, y: 0 },
        config: {
          code: "return input.event.n * 2;",
          inputs: [{ name: "event", type: "object" }],
          outputs: [{ name: "value", type: "number" }],
        },
      },
      { id: "w", type: "variable_write", position: { x: 0, y: 0 }, config: { inputs: [{ name: "doubled", type: "number" }] } },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "compute", toPort: "event" },
      { id: "c3", from: "compute", fromPort: "value", to: "w", toPort: "doubled" },
    ],
  };
}

/** Результат вычисления виден в трассе: variable_write наружу данных не отдаёт. */
function tracedOutput(result: any, nodeId: string) {
  return result.trace.find((entry: any) => entry.nodeId === nodeId)?.outputs;
}

function start(runtime: any, workflowId: string, input: Record<string, unknown>) {
  return runtime.start({ organizationId: ORG, workflowId, context, input, startNodeId: "evt" });
}

describe("Деградация при недоступном Backend (ТЗ §5.4, §13.2)", () => {
  it("экземпляр с узлом Backend API падает штатно в failed с журналом, движок не рушится", async () => {
    const backend = createUnavailableBackend();
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: backend, metrics, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });

    const res = await start(runtime, "wf-backend", { title: "заявка" });

    assert.equal(res.status, "failed", "недоступный Backend → экземпляр failed, а не исключение наружу");
    assert.equal(res.error.reason, "backend_unavailable", "причина сбоя доехала до вызывающей стороны");
    assert.equal(res.error.node_id, "create");
    assert.equal(backend.calls, 1, "движок действительно попытался вызвать Backend");
    // Журнал сохраняется ВСЕГДА (для workflow_execution_logs, §13.9).
    const eventsList = res.journal.map((e: any) => e.event);
    assert.ok(eventsList.includes("workflow.failed"), "в журнале есть workflow.failed");
    assert.ok(eventsList.includes("node.failed"));

    // Метрика §24.6 фиксирует ошибку.
    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, 1);
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 0);
    assert.equal(snap.total.active, 0, "упавший экземпляр перестаёт быть активным");
  });

  it("после ошибки Backend движок продолжает исполнять transform-only Workflow (ядро не заблокировано)", async () => {
    const backend = createUnavailableBackend();
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: backend, metrics, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-transform", schema: transformOnlySchema() });

    // Backend-workflow падает…
    const failed = await start(runtime, "wf-backend", { title: "x" });
    assert.equal(failed.status, "failed");

    // …но Workflow, которому Backend не нужен, исполняется как обычно.
    const ok = await start(runtime, "wf-transform", { n: 21 });
    assert.equal(ok.status, "completed", "движок остаётся пригодным при недоступном Backend");
    assert.deepEqual(tracedOutput(ok, "compute"), { value: 42 });
    assert.equal(backend.calls, 1, "transform-only схема к Backend не ходила вовсе");

    // Метрики отражают и ошибку, и успех.
    const snap = metrics.snapshot();
    assert.equal(snap.total.runs, 2);
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 1);
    assert.equal(snap.total.active, 0);
  });

  it("восстановление Backend: тот же движок доводит новый экземпляр до успеха", async () => {
    // Единый мок, который сначала «недоступен», затем «восстанавливается».
    const healthy = createTenantBackendApiMock({ now: fixedNow });
    let up = false;
    const flaky = {
      async call(args: any) {
        if (!up) {
          const error = new Error("Backend недоступен.");
          (error as any).reason = "backend_unavailable";
          throw error;
        }
        return healthy.call(args);
      },
    };
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: flaky, metrics, now: fixedNow, limits: { codeTimeoutMs: 5000 } });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });

    const down = await start(runtime, "wf-backend", { title: "во время сбоя" });
    assert.equal(down.status, "failed");

    up = true; // Backend восстановился.
    const recovered = await start(runtime, "wf-backend", { title: "после восстановления" });
    assert.equal(recovered.status, "completed", "движок не «залипает» в деградации после восстановления");
    assert.deepEqual(recovered.output.response.body.echo, { title: "после восстановления" });

    const snap = metrics.snapshot();
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 1);
  });
});
