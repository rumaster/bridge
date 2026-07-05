/**
 * Нагрузочный пробник FBP Engine (ТЗ §25.11, §25.3) — «зафиксируй измерения»:
 * прогоняет N экземпляров Workflow через кластер из K stateless-узлов-исполнителей
 * (round-robin на старте и на продолжении), затем печатает измерения и снимок
 * метрик §24.6 (запуски/успехи/ошибки/среднее время/активные) в текстовом
 * формате Prometheus.
 *
 * Запуск: node experiments/m5-fbp-load-probe.ts [N] [K]
 *
 * В отличие от детерминированного ядра, ЗДЕСЬ допустимо читать системное время
 * (`performance.now`) — это внешний измеритель, а не логика движка.
 */
import { performance } from "node:perf_hooks";

import { createTenantBackendApiMock } from "../services/fbp-engine/src/backend/client.js";
import {
  createFbpRuntime,
  createWorkflowMetrics,
  renderWorkflowMetrics,
} from "../services/fbp-engine/src/engine.js";

const N = Number.parseInt(process.argv[2] ?? "200", 10);
const K = Number.parseInt(process.argv[3] ?? "4", 10);
const ORG = "org-load";
// Инъекция времени в движок — детерминированные метки; длительность экземпляров
// в снимке §24.6 при этом равна 0 (движок не читает системное время сам).
const now = () => "2026-07-04T00:00:00.000Z";

const schema = {
  schema_version: "1.0.0",
  workflow_id: "wf-load",
  entry: "prepare",
  nodes: [
    {
      id: "prepare",
      type: "transform",
      input: { name: { kind: "params", path: ["name"] } },
      config: { expression: { op: "merge", args: [{ op: "input" }, { op: "lit", value: { source: "probe" } }] } },
    },
    { id: "gate", type: "wait-event", config: { event_type: "approved" } },
    {
      id: "persist",
      type: "backend-api",
      input: {
        name: { kind: "node", node: "prepare", path: ["name"] },
        decision: { kind: "node", node: "gate", path: ["decision"] },
      },
      config: { method: "POST", path: "/api/v1/records", body: { op: "input" } },
    },
  ],
  connections: [
    { from: "prepare", to: "gate" },
    { from: "gate", to: "persist" },
  ],
};

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

// Общий кластер: реестр версий, хранилище состояния и коллектор метрик разделяются
// между K узлами-исполнителями (в бою — Backend по C3, §25.3).
const mock = createTenantBackendApiMock({ now });
const metrics = createWorkflowMetrics();
const seed = createFbpRuntime({ backendClient: mock, metrics, now });
const nodes = Array.from({ length: K }, () =>
  createFbpRuntime({ backendClient: mock, versions: seed.versions, instances: seed.instances, metrics, now }),
);

seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema });

console.log(`Нагрузочный пробник: N=${N} экземпляров, K=${K} stateless-узлов\n`);

// Фаза 1: старт (round-robin) — каждый экземпляр уходит в ожидание.
const startAt = performance.now();
const started = [];
for (let i = 0; i < N; i += 1) {
  const res = await nodes[i % K].start({ organizationId: ORG, workflowId: "wf-load", context, input: { name: `u${i}` } });
  started.push(res);
}
const startMs = performance.now() - startAt;

const afterStart = metrics.snapshot();
console.log(`Фаза старта:      ${startMs.toFixed(1)} мс, ${(N / (startMs / 1000)).toFixed(0)} экз/с`);
console.log(`  активны (waiting): ${afterStart.total.active} из ${afterStart.total.runs} запусков`);

// Фаза 2: продолжение на ДРУГОМ узле (перебалансировка нагрузки между исполнителями).
const resumeAt = performance.now();
let completed = 0;
for (let i = 0; i < started.length; i += 1) {
  const res = await nodes[(i + Math.floor(K / 2)) % K].resume({
    organizationId: ORG,
    instanceId: started[i].instance_id,
    event: { decision: "ok" },
  });
  if (res.status === "completed") {
    completed += 1;
  }
}
const resumeMs = performance.now() - resumeAt;

console.log(`Фаза продолжения: ${resumeMs.toFixed(1)} мс, ${(N / (resumeMs / 1000)).toFixed(0)} экз/с`);
console.log(`  завершено: ${completed} из ${N}`);

const snap = metrics.snapshot();
console.log(`\nМетрики §24.6 (сводно):`);
console.log(`  запуски:          ${snap.total.runs}`);
console.log(`  успехи:           ${snap.total.successes}`);
console.log(`  ошибки:           ${snap.total.errors}`);
console.log(`  активные:         ${snap.total.active}`);
console.log(`  среднее время, мс: ${snap.total.avg_duration_ms}`);
console.log(`  записей в Backend: ${mock.writesFor(ORG).length}`);

console.log(`\n--- /metrics (Prometheus, §24.3/§24.6) ---`);
console.log(renderWorkflowMetrics(snap));

// Инварианты пробника: все стартовали, все завершились успешно, активных не осталось.
const ok = snap.total.runs === N && snap.total.successes === N && snap.total.errors === 0 && snap.total.active === 0;
console.log(ok ? "OK: все экземпляры завершены успешно, активных нет." : "FAIL: инварианты пробника нарушены.");
process.exit(ok ? 0 : 1);
