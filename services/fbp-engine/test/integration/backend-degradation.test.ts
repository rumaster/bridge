import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { createFbpRuntime, createWorkflowMetrics } from "../../src/engine.js";

const ORG = "org-degrade";
const fixedNow = () => "2026-07-04T00:00:00.000Z";
const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

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

function backendSchema() {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-backend",
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
}

function transformOnlySchema() {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-transform",
    entry: "compute",
    nodes: [
      {
        id: "compute",
        type: "transform",
        input: { n: { kind: "params", path: ["n"] } },
        config: { expression: { op: "mul", args: [{ op: "get", object: { op: "input" }, path: ["n"] }, { op: "lit", value: 2 }] } },
      },
    ],
    connections: [],
  };
}

describe("Деградация при недоступном Backend (ТЗ §5.4, §13.2)", () => {
  it("экземпляр с узлом Backend API падает штатно в failed с журналом, движок не рушится", async () => {
    const backend = createUnavailableBackend();
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: backend, metrics, now: fixedNow });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });

    const res = await runtime.start({ organizationId: ORG, workflowId: "wf-backend", context, input: { title: "заявка" } });

    assert.equal(res.status, "failed", "недоступный Backend → экземпляр failed, а не исключение наружу");
    assert.equal(backend.calls, 1, "движок действительно попытался вызвать Backend");
    // Журнал сохраняется ВСЕГДА (для workflow_execution_logs, §13.9).
    const eventsList = res.journal.map((e) => e.event);
    assert.ok(eventsList.includes("workflow.failed"), "в журнале есть workflow.failed");

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
    const runtime = createFbpRuntime({ backendClient: backend, metrics, now: fixedNow });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-transform", schema: transformOnlySchema() });

    // Backend-workflow падает…
    const failed = await runtime.start({ organizationId: ORG, workflowId: "wf-backend", context, input: { title: "x" } });
    assert.equal(failed.status, "failed");

    // …но transform-only Workflow (не требующий Backend) исполняется как обычно.
    const ok = await runtime.start({ organizationId: ORG, workflowId: "wf-transform", context, input: { n: 21 } });
    assert.equal(ok.status, "completed", "движок остаётся пригодным при недоступном Backend");
    assert.equal(ok.output, 42);

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
      async call(args) {
        if (!up) {
          const error = new Error("Backend недоступен.");
          (error as any).reason = "backend_unavailable";
          throw error;
        }
        return healthy.call(args);
      },
    };
    const metrics = createWorkflowMetrics();
    const runtime = createFbpRuntime({ backendClient: flaky, metrics, now: fixedNow });
    runtime.publishVersion({ organizationId: ORG, workflowId: "wf-backend", schema: backendSchema() });

    const down = await runtime.start({ organizationId: ORG, workflowId: "wf-backend", context, input: { title: "во время сбоя" } });
    assert.equal(down.status, "failed");

    up = true; // Backend восстановился.
    const recovered = await runtime.start({ organizationId: ORG, workflowId: "wf-backend", context, input: { title: "после восстановления" } });
    assert.equal(recovered.status, "completed");
    assert.deepEqual(recovered.output.body.echo, { title: "после восстановления" });

    const snap = metrics.snapshot();
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 1);
  });
});
