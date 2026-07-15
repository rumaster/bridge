/**
 * Нагрузочный пробник FBP Engine (ТЗ §25.11, §25.3) — «зафиксируй измерения»:
 * прогоняет N экземпляров Workflow через кластер из K stateless-узлов-исполнителей
 * (round-robin), затем печатает измерения и снимок метрик §24.6
 * (запуски/успехи/ошибки/среднее время/активные) в текстовом формате Prometheus.
 *
 * Запуск: node --import tsx experiments/m5-fbp-load-probe.ts [N] [K]
 *
 * Ревизия 2026-07-15: фаз «старт → ожидание → продолжение» больше нет — узел
 * «Ожидание события» стал точкой входа, `resume` удалён. Пробник меряет сквозное
 * исполнение: событие → вызов Backend API.
 *
 * В отличие от детерминированного ядра, ЗДЕСЬ допустимо читать системное время
 * (`performance.now`) — это внешний измеритель, а не логика движка.
 */
import { performance } from "node:perf_hooks";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
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

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
);
if (!POST_OP) {
  throw new Error("В каталоге Backend API нет POST-операции без плейсхолдеров — пробник не собрать.");
}

/**
 * Событие → вызов Backend API. Узел transform сознательно не используется: он
 * исполняется в отдельном процессе-песочнице, и на N=200 пробник мерил бы
 * стоимость спавна процессов, а не пропускную способность исполнителей.
 */
const schema = {
  schema_version: WORKFLOW_SCHEMA_VERSION,
  kind: "workflow",
  workflow_id: "wf-load",
  nodes: [
    { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
    {
      id: "persist",
      type: "backend-api",
      position: { x: 0, y: 0 },
      config: { operation_id: POST_OP.operation_id, inputs: [{ name: "body", type: "object" }] },
    },
  ],
  connections: [
    { id: "c1", from: "evt", fromPort: "out", to: "persist", toPort: "in" },
    { id: "c2", from: "evt", fromPort: "data", to: "persist", toPort: "body" },
  ],
};

const context = { organization_id: ORG, actor_user_id: "u1", trigger: "manual" };

// Общий кластер: реестр версий, хранилище экземпляров и коллектор метрик разделяются
// между K узлами-исполнителями (в бою — Backend по C3, §25.3).
const mock = createTenantBackendApiMock({ now });
const metrics = createWorkflowMetrics();
const seed = createFbpRuntime({ backendClient: mock, metrics, now });
const nodes = Array.from({ length: K }, () =>
  createFbpRuntime({ backendClient: mock, versions: seed.versions, instances: seed.instances, metrics, now }),
);

seed.publishVersion({ organizationId: ORG, workflowId: "wf-load", schema });

console.log(`Нагрузочный пробник: N=${N} экземпляров, K=${K} stateless-узлов\n`);

// Сквозное исполнение (round-robin по узлам кластера).
const startAt = performance.now();
let completed = 0;
for (let i = 0; i < N; i += 1) {
  const res = await nodes[i % K].start({
    organizationId: ORG,
    workflowId: "wf-load",
    context,
    input: { name: `u${i}` },
    startNodeId: "evt",
  });
  if (res.status === "completed") {
    completed += 1;
  }
}
const elapsedMs = performance.now() - startAt;

console.log(`Исполнение: ${elapsedMs.toFixed(1)} мс, ${(N / (elapsedMs / 1000)).toFixed(0)} экз/с`);
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

// Инварианты пробника: все стартовали, все завершились успешно, активных не осталось,
// и каждая запись в Backend ушла от имени своего арендатора.
const tenantClean = mock.received.every((call: any) => call.organization_id === ORG);
const ok =
  snap.total.runs === N &&
  snap.total.successes === N &&
  snap.total.errors === 0 &&
  snap.total.active === 0 &&
  mock.writesFor(ORG).length === N &&
  tenantClean;
console.log(ok ? "OK: все экземпляры завершены успешно, активных нет." : "FAIL: инварианты пробника нарушены.");
process.exit(ok ? 0 : 1);
