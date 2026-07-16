import { TRANSFORM_DEFAULT_LIMITS } from "../../../packages/contracts/src/c5.js";
import { ExecutionContext } from "./core/execution-context.js";
import { WorkflowExecutionError } from "./core/errors.js";
import { runGraph } from "./core/executor.js";
import { deterministicUuid } from "./core/ids.js";
import { assertWorkflowSchema, validateWorkflowSchema } from "./schema/validate-workflow.js";
import { createVersionRegistry } from "./versions/version-registry.js";
import { createInstanceStore } from "./state/instance-store.js";
import { createInstanceRuntime } from "./runtime/instance-runtime.js";
import { createWorkflowMetrics } from "./metrics/workflow-metrics.js";
import type { BackendApiClient } from "./backend/client.js";

/** Опции фасада движка {@link createFbpEngine}. */
export interface FbpEngineOptions {
  backendClient?: BackendApiClient;
  limits?: Record<string, unknown>;
  now?: () => string;
  resolveSubSchema?: any;
}

/** Аргументы {@link createFbpEngine.runWorkflow}. */
export interface RunWorkflowOptions {
  schema?: any;
  context?: any;
  input?: Record<string, unknown>;
  instanceId?: string;
  /**
   * Узел «Ожидание события», с которого начинается исполнение. Обязателен для
   * схемы верхнего уровня: с ревизии 2026-07-15 точка входа — сработавшая
   * подписка, а не `schema.entry`. Для субсхемы не нужен — там старт с узла
   * `start`.
   */
  startNodeId?: string;
}

/** Опции сборки рантайма {@link createFbpRuntime}. */
export interface FbpRuntimeOptions {
  backendClient?: BackendApiClient;
  now?: () => string;
  versions?: ReturnType<typeof createVersionRegistry>;
  instances?: ReturnType<typeof createInstanceStore>;
  metrics?: ReturnType<typeof createWorkflowMetrics>;
  limits?: Record<string, unknown>;
  resolveSubSchema?: any;
}

/**
 * Фасад движка Workflow (форк fbp-engine, ТЗ §13.13). Предоставляет две операции:
 *
 *  - `validateSchema(schema)` — валидация НА ЭТАПЕ СОХРАНЕНИЯ (CP-5, §16.7): всё,
 *    что можно проверить статически (типы узлов, конфигурация, запрет операций
 *    Transform вне whitelist, DAG), проверяется до создания новой версии.
 *  - `runWorkflow({ schema, context, input })` — пошаговое исполнение (CP-4):
 *    старт → узлы → финал, с журналом (`workflow_execution_logs`).
 *
 * Движок НЕ инициирует Workflow сам (§6.13) — инициатор всегда Backend, который
 * передаёт `context` с арендатором и актором. Движок не исполняет SQL и не имеет
 * прямого доступа к БД/внутренним сервисам: единственный канал данных — узел
 * Backend API через переданный `backendClient` (канал C3, §13.12, §13.13-п.3).
 */
export function createFbpEngine({ backendClient, limits = {}, now, resolveSubSchema = null }: FbpEngineOptions = {}) {
  if (!backendClient || typeof backendClient.call !== "function") {
    throw new TypeError(
      "createFbpEngine требует backendClient с методом call — движок меняет и читает данные только через Backend API (C3).",
    );
  }
  const effectiveLimits = Object.freeze({ ...TRANSFORM_DEFAULT_LIMITS, ...limits });

  return {
    /** Валидация схемы Workflow на этапе сохранения. Возвращает `{ valid, errors }`. */
    validateSchema(schema, options = {}) {
      return validateWorkflowSchema(schema, { limits: effectiveLimits, ...options });
    },

    /**
     * Исполнить экземпляр Workflow. Возвращает
     * `{ instance_id, organization_id, status, output, journal, ... }`.
     * Ошибки исполнения фиксируются в журнале (`workflow.failed`) и возвращаются
     * как `status:"failed"` — журнал возвращается ВСЕГДА, чтобы Backend мог его
     * сохранить в `workflow_execution_logs`.
     */
    async runWorkflow({ schema, context, input = {}, instanceId, startNodeId }: RunWorkflowOptions = {}) {
      assertWorkflowSchema(schema, { limits: effectiveLimits });
      const resolvedInstanceId = resolveInstanceId(instanceId, context, schema, input);
      const ctx = createContext({ context, schema, input, instanceId: resolvedInstanceId, now, resolveSubSchema });

      try {
        const result = await runGraph({
          schema,
          ctx,
          backendClient,
          limits: effectiveLimits,
          startNodeId,
        });
        return { instance_id: resolvedInstanceId, organization_id: ctx.organizationId, ...result };
      } catch (error) {
        ctx.appendJournal("workflow.failed", {
          nodeId: error?.nodeId ?? null,
          data: { reason: error?.reason ?? "error", message: error?.message ?? String(error) },
        });
        return {
          instance_id: resolvedInstanceId,
          organization_id: ctx.organizationId,
          status: "failed",
          output: null,
          error: {
            reason: error?.reason ?? "error",
            message: error?.message ?? String(error),
            node_id: error?.nodeId ?? null,
            node_type: error?.nodeType ?? null,
          },
          journal: ctx.journal,
          // Трасса нужнее всего именно здесь: без неё не видно, до какого узла
          // схема дошла и с какими входами упала. Пустой массив, а не undefined —
          // форма ответа не должна зависеть от исхода.
          trace: Array.isArray(error?.trace) ? error.trace : [],
        };
      }
    },
  };
}

/**
 * Собранный рантайм вехи M4: реестр неизменяемых версий (`versions`), хранилище
 * экземпляров и внешнего состояния (`instances`) и оркестратор (`start`/`resume`)
 * с version pinning и stateless-продолжением. Компоненты можно переиспользовать
 * между «узлами-исполнителями», передав общее хранилище — так моделируется
 * горизонтальное масштабирование (ТЗ §25.3): любой узел обрабатывает любой
 * экземпляр по `workflow_instance_state`.
 */
export function createFbpRuntime({
  backendClient,
  now,
  versions: providedVersions,
  instances = createInstanceStore({ ...(now ? { now } : {}) }),
  metrics = createWorkflowMetrics(),
  limits = {},
  resolveSubSchema = null,
}: FbpRuntimeOptions = {}) {
  if (!backendClient || typeof backendClient.call !== "function") {
    throw new TypeError(
      "createFbpRuntime требует backendClient с методом call — данные идут только через Backend API (C3).",
    );
  }

  /**
   * Лимиты обязаны дойти до валидации НА СОХРАНЕНИИ (ТЗ §13.13-п.5), иначе
   * ужесточённый maxCodeLength действовал бы только на исполнении: реестр версий
   * молча валидировал бы с пустыми опциями и публиковал схему, которую сам же
   * потом отверг бы. Раньше реестр строился прямо в деструктуризации аргументов —
   * до объявления `limits`, поэтому дотянуться до них было физически нельзя.
   * Путь `createFbpEngine.runWorkflow` лимиты передавал, а этот — нет.
   */
  const effectiveLimits = Object.freeze({ ...TRANSFORM_DEFAULT_LIMITS, ...limits });
  const versions =
    providedVersions ??
    createVersionRegistry({
      ...(now ? { now } : {}),
      validateSchema: (schema, options = {}) =>
        validateWorkflowSchema(schema, { limits: effectiveLimits, ...options }),
    });

  const runtime = createInstanceRuntime({
    backendClient,
    versions,
    instances,
    metrics,
    limits,
    resolveSubSchema,
    ...(now ? { now } : {}),
  });
  return {
    versions,
    instances,
    metrics,
    /** Опубликовать версию схемы (неизменяемо, ТЗ §13.10). */
    publishVersion: (args) => versions.publishVersion(args),
    /** Переключить версию по умолчанию — конфигурацией (ТЗ §13.10). */
    setDefaultVersion: (args) => versions.setDefaultVersion(args),
    /**
     * Запустить экземпляр с узла «Ожидание события» (version pinning на старте).
     * Ревизия 2026-07-15: `resume` удалён — событие запускает новый экземпляр, а
     * не будит спящий (см. `runtime/instance-runtime.ts`).
     */
    start: (args) => runtime.start(args),
    /** Снимок метрик исполнения Workflow (ТЗ §24.6). */
    getMetrics: () => metrics.snapshot(),
  };
}

export { validateWorkflowSchema, assertWorkflowSchema } from "./schema/validate-workflow.js";
export { createVersionRegistry } from "./versions/version-registry.js";
export { createInstanceStore } from "./state/instance-store.js";
export { createInstanceRuntime } from "./runtime/instance-runtime.js";
export { createWorkflowMetrics, renderWorkflowMetrics } from "./metrics/workflow-metrics.js";

function createContext({ context, schema, input, instanceId, now, resolveSubSchema = null }) {
  if (!context || typeof context.organization_id !== "string" || context.organization_id.trim() === "") {
    throw new WorkflowExecutionError(
      "invalid_context",
      "runWorkflow требует context.organization_id — инициатор Workflow всегда Backend (§6.13).",
    );
  }
  return new ExecutionContext({
    organizationId: context.organization_id,
    actorUserId: context.actor_user_id ?? null,
    trigger: context.trigger ?? null,
    roles: context.roles ?? [],
    correlationId: context.correlation_id ?? null,
    locale: context.locale ?? null,
    instanceId,
    workflowId: schema.workflow_id ?? null,
    workflowVersionId: schema.workflow_version_id ?? null,
    input,
    resolveSubSchema,
    resolvedSubSchemas: schema.__resolved_subschemas ?? null,
    ...(now ? { now } : {}),
  });
}

function resolveInstanceId(instanceId, context, schema, input) {
  if (typeof instanceId === "string" && instanceId.trim() !== "") {
    return instanceId;
  }
  return deterministicUuid([
    context?.organization_id ?? "",
    schema?.workflow_version_id ?? schema?.workflow_id ?? "",
    stableStringify(input ?? {}),
  ]);
}

// Детерминированная сериализация с сортировкой ключей — instance_id одинаков при
// одинаковом входе независимо от порядка ключей (без ГСЧ/времени).
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
