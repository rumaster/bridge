/**
 * Метрики исполнения Workflow (ТЗ §24.6, §13.9). Собирает по каждому Workflow и
 * суммарно ровно те показатели, что предписывает §24.6 «Мониторинг Workflow»:
 *
 *  - **количество запусков** (`runs`) — сколько экземпляров стартовало;
 *  - **успешные выполнения** (`successes`) — сколько завершилось `completed`;
 *  - **ошибки** (`errors`) — сколько завершилось `failed`;
 *  - **среднее время исполнения** (`avg_duration_ms`) — по завершённым (успех/ошибка);
 *  - **активные экземпляры** (`active`) — стартовавшие, но ещё не терминальные
 *    (в т.ч. `waiting` в ожидании события — они остаются активными).
 *
 * Коллектор ДЕТЕРМИНИРОВАН и не обращается к среде: не читает системное время
 * (длительность приходит вычисленной снаружи из меток `started_at`/`finished_at`)
 * и не использует ГСЧ. Это отдельный in-memory агрегатор для наблюдаемости —
 * канонический журнал остаётся `workflow_execution_logs` (§13.9), владеет им
 * Backend; здесь — сводные счётчики для `/metrics` и для нагрузочных пробников M5.
 */

/** Событие запуска экземпляра для коллектора метрик. */
export interface WorkflowMetricStartEvent {
  workflowId?: string | null;
}

/** Событие завершения экземпляра для коллектора метрик. */
export interface WorkflowMetricCompletionEvent {
  workflowId?: string | null;
  status?: string;
  durationMs?: number;
}

/** Строка снимка метрик (суммарная — без `workflow_id`, по-Workflow — с ним). */
export interface WorkflowMetricsRow {
  workflow_id?: string;
  runs: number;
  successes: number;
  errors: number;
  active: number;
  avg_duration_ms: number;
}

export function createWorkflowMetrics() {
  const perWorkflow = new Map(); // workflow_id -> counters
  const totals = newCounters(null);

  function bucket(workflowId) {
    const id = typeof workflowId === "string" && workflowId.trim() !== "" ? workflowId : "unknown";
    let counters = perWorkflow.get(id);
    if (!counters) {
      counters = newCounters(id);
      perWorkflow.set(id, counters);
    }
    return counters;
  }

  return {
    /** Зафиксировать запуск экземпляра (инкремент `runs` и `active`). */
    recordStart({ workflowId }: WorkflowMetricStartEvent = {}) {
      const counters = bucket(workflowId);
      counters.runs += 1;
      counters.active += 1;
      totals.runs += 1;
      totals.active += 1;
    },

    /**
     * Зафиксировать переход экземпляра в терминальное состояние. Для `completed`/
     * `failed` уменьшает `active` и учитывает длительность; для `waiting` и прочих
     * НЕтерминальных статусов — ничего не меняет (экземпляр остаётся активным).
     */
    recordCompletion({ workflowId, status, durationMs = 0 }: WorkflowMetricCompletionEvent = {}) {
      if (status !== "completed" && status !== "failed") {
        return;
      }
      const counters = bucket(workflowId);
      if (status === "completed") {
        counters.successes += 1;
        totals.successes += 1;
      } else {
        counters.errors += 1;
        totals.errors += 1;
      }
      counters.active = Math.max(0, counters.active - 1);
      totals.active = Math.max(0, totals.active - 1);

      const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
      counters.durationSum += duration;
      counters.finished += 1;
      totals.durationSum += duration;
      totals.finished += 1;
    },

    /**
     * Снимок метрик §24.6: суммарно (`total`) и по каждому Workflow (`workflows`,
     * отсортированы по `workflow_id` для детерминизма).
     */
    snapshot() {
      return {
        total: shape(totals),
        workflows: [...perWorkflow.values()]
          .sort((a, b) => (a.workflowId < b.workflowId ? -1 : a.workflowId > b.workflowId ? 1 : 0))
          .map(shape),
      };
    },
  };
}

function newCounters(workflowId) {
  return { workflowId, runs: 0, successes: 0, errors: 0, active: 0, durationSum: 0, finished: 0 };
}

function shape(counters): WorkflowMetricsRow {
  const base = {
    runs: counters.runs,
    successes: counters.successes,
    errors: counters.errors,
    active: counters.active,
    avg_duration_ms: counters.finished > 0 ? counters.durationSum / counters.finished : 0,
  };
  return counters.workflowId === null ? base : { workflow_id: counters.workflowId, ...base };
}

/**
 * Отрисовать снимок метрик в текстовом формате Prometheus (`/metrics`, §24.3).
 * Суммарные ряды — без меток; по-Workflow — с меткой `workflow_id`.
 */
export function renderWorkflowMetrics(snapshot) {
  const lines = [];
  const families = [
    ["fbp_engine_workflow_runs_total", "counter", "Запуски экземпляров Workflow (§24.6).", "runs"],
    ["fbp_engine_workflow_successes_total", "counter", "Успешно завершённые экземпляры Workflow (§24.6).", "successes"],
    ["fbp_engine_workflow_errors_total", "counter", "Экземпляры Workflow, завершённые ошибкой (§24.6).", "errors"],
    ["fbp_engine_workflow_active", "gauge", "Активные (ещё не терминальные) экземпляры Workflow (§24.6).", "active"],
    ["fbp_engine_workflow_avg_duration_ms", "gauge", "Среднее время исполнения экземпляра Workflow, мс (§24.6).", "avg_duration_ms"],
  ];

  for (const [name, type, help, field] of families) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${snapshot.total[field]}`);
    for (const workflow of snapshot.workflows) {
      lines.push(`${name}{workflow_id="${escapeLabel(workflow.workflow_id)}"} ${workflow[field]}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
