import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWorkflowMetrics,
  renderWorkflowMetrics,
} from "../../src/metrics/workflow-metrics.mjs";

describe("Метрики Workflow (§24.6): запуски, успехи, ошибки, среднее время, активные", () => {
  it("считает запуски, успехи и активные экземпляры по каждому Workflow и суммарно", () => {
    const metrics = createWorkflowMetrics();

    metrics.recordStart({ workflowId: "wf-a" });
    metrics.recordStart({ workflowId: "wf-a" });
    metrics.recordStart({ workflowId: "wf-b" });

    // Один из wf-a завершается успехом, второй пока активен.
    metrics.recordCompletion({ workflowId: "wf-a", status: "completed", durationMs: 100 });

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.total.runs, 3);
    assert.equal(snapshot.total.successes, 1);
    assert.equal(snapshot.total.errors, 0);
    assert.equal(snapshot.total.active, 2, "один wf-a и один wf-b ещё активны");

    const wfA = snapshot.workflows.find((w) => w.workflow_id === "wf-a");
    assert.equal(wfA.runs, 2);
    assert.equal(wfA.successes, 1);
    assert.equal(wfA.active, 1);
    assert.equal(wfA.avg_duration_ms, 100);
  });

  it("ошибки уменьшают активные и учитываются отдельно от успехов", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordCompletion({ workflowId: "wf", status: "failed", durationMs: 40 });

    const snap = metrics.snapshot();
    assert.equal(snap.total.errors, 1);
    assert.equal(snap.total.successes, 0);
    assert.equal(snap.total.active, 1);
  });

  it("среднее время исполнения усредняет только завершённые экземпляры", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordCompletion({ workflowId: "wf", status: "completed", durationMs: 200 });
    metrics.recordCompletion({ workflowId: "wf", status: "failed", durationMs: 100 });
    // третий экземпляр ещё активен и в среднее не входит.

    const snap = metrics.snapshot();
    assert.equal(snap.total.avg_duration_ms, 150);
    assert.equal(snap.total.active, 1);
  });

  it("статус waiting не считается терминальным — активные не уменьшаются", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordCompletion({ workflowId: "wf", status: "waiting", durationMs: 999 });

    const snap = metrics.snapshot();
    assert.equal(snap.total.active, 1);
    assert.equal(snap.total.successes, 0);
    assert.equal(snap.total.errors, 0);
    assert.equal(snap.total.avg_duration_ms, 0, "waiting не даёт вклада в среднее время");
  });

  it("некорректная/отрицательная длительность нормализуется в 0", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordCompletion({ workflowId: "wf", status: "completed", durationMs: -5 });
    metrics.recordStart({ workflowId: "wf" });
    metrics.recordCompletion({ workflowId: "wf", status: "completed", durationMs: Number.NaN });

    assert.equal(metrics.snapshot().total.avg_duration_ms, 0);
  });

  it("экземпляры без workflow_id аккумулируются в бакет unknown", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({});
    metrics.recordCompletion({ status: "completed", durationMs: 10 });

    const snap = metrics.snapshot();
    assert.equal(snap.workflows[0].workflow_id, "unknown");
    assert.equal(snap.workflows[0].successes, 1);
  });

  it("active не уходит ниже нуля при лишних завершениях", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordCompletion({ workflowId: "wf", status: "completed", durationMs: 1 });
    assert.equal(metrics.snapshot().total.active, 0);
  });

  it("renderWorkflowMetrics выдаёт валидный текст Prometheus с рядами по Workflow", () => {
    const metrics = createWorkflowMetrics();
    metrics.recordStart({ workflowId: "wf-a" });
    metrics.recordCompletion({ workflowId: "wf-a", status: "completed", durationMs: 50 });

    const text = renderWorkflowMetrics(metrics.snapshot());
    assert.match(text, /# TYPE fbp_engine_workflow_runs_total counter/);
    assert.match(text, /fbp_engine_workflow_runs_total 1/);
    assert.match(text, /fbp_engine_workflow_runs_total\{workflow_id="wf-a"\} 1/);
    assert.match(text, /fbp_engine_workflow_successes_total\{workflow_id="wf-a"\} 1/);
    assert.match(text, /fbp_engine_workflow_avg_duration_ms\{workflow_id="wf-a"\} 50/);
    assert.ok(text.endsWith("\n"));
  });
});
